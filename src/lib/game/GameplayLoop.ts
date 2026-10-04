import { Server as SocketIOServer } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  Game,
  GamePhase,
  Question,
  PhaseDeadline,
  Player,
  PlayerStanding
} from '@/types/game';
import { GameManager, sanitizeGameForClient, toPublicPlayer } from './GameManager';
import { finishGame as dbFinishGame } from '@/lib/db';
import { PlayerManager } from './PlayerManager';
import { QuestionManager } from './QuestionManager';
import { TimerManager } from './TimerManager';

// How long to wait for the host to reconnect after they disconnect before finishing the game.
// Tunable: longer = friendlier for flaky wifi, shorter = faster cleanup of dead games.
const HOST_DISCONNECT_GRACE_MS = 5 * 60_000; // 5 minutes — enough time for host to reopen browser, find the URL, and resume

// Phase 5: idle-game GC — auto-finish games with no activity for this long
const IDLE_GAME_TTL_MS = 2 * 60 * 60_000; // 2 hours
const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000; // check every 5 minutes

// Phase 6: server-authoritative deadline + late-answer grace window
// Client thinks the deadline is `deadlineMs`; server actually accepts up to `deadlineMs + ANSWER_GRACE_MS`.
// This compensates for Ethiopian 3G/4G round-trip latency without enabling meaningful cheating.
export const ANSWER_GRACE_MS = 1000;

// TimerManager key prefix for the per-socket "resync to answering" follow-up emit.
const RESYNC_TIMER_PREFIX = 'resyncAnswering_';

// Players see this many rows on the mid-game leaderboard (plus their own standing). The
// host projector gets the full list. 200 Player rows x 200 phones was the single largest
// per-question payload.
export const LEADERBOARD_TOP_N = 10;

// Host-only "N of M answered" progress: coalesce bursts to at most one emit per 250 ms.
// 200 players answering inside 10 s used to mean 200 room broadcasts = 40k packets.
const ANSWERED_NOTIFY_MIN_INTERVAL_MS = 250;
const ANSWERED_NOTIFY_TIMER = 'answeredNotify';

export class GameplayLoop {
  private phaseCallbacks: Map<string, (() => void) | null> = new Map();
  // gameId -> last time the host was sent the answered-count (throttle state).
  private lastAnsweredNotifyAt: Map<string, number> = new Map();
  private hostDisconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private idleSweepInterval: NodeJS.Timeout | null = null;

  constructor(
    private io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>,
    private gameManager: GameManager,
    private playerManager: PlayerManager,
    private questionManager: QuestionManager,
    private timerManager: TimerManager
  ) {
    this.startIdleSweep();
  }

  /**
   * Phase 5: periodic sweep — finish games with no activity for IDLE_GAME_TTL_MS.
   * Runs every IDLE_SWEEP_INTERVAL_MS. Cleared on shutdown.
   */
  private startIdleSweep(): void {
    this.idleSweepInterval = setInterval(() => {
      const cutoff = Date.now() - IDLE_GAME_TTL_MS;
      for (const game of this.gameManager.getAllGames()) {
        if (game.status === 'finished') continue;
        const last = game.lastActivityAt ?? game.phaseStartTime ?? 0;
        if (last > 0 && last < cutoff) {
          const idleMin = Math.round((Date.now() - last) / 60_000);
          console.log(`[idle-gc] Finishing idle game PIN ${game.pin} (idle ${idleMin}m, phase=${game.phase})`);
          // If the loop is active, transition normally; otherwise direct cleanup
          if (game.gameLoopActive) {
            this.transitionToPhase(game, 'finished');
          } else {
            this.executeFinishedPhase(game);
          }
        }
      }
    }, IDLE_SWEEP_INTERVAL_MS);
    // Don't block process exit on this timer
    if (this.idleSweepInterval.unref) this.idleSweepInterval.unref();
    console.log(`[idle-gc] Started — sweep every ${IDLE_SWEEP_INTERVAL_MS / 60_000}m, TTL ${IDLE_GAME_TTL_MS / 60_000}m`);
  }

  stopIdleSweep(): void {
    if (this.idleSweepInterval) {
      clearInterval(this.idleSweepInterval);
      this.idleSweepInterval = null;
    }
  }

  startGameLoop(game: Game): void {
    if (game.gameLoopActive) {
      console.log(`[PIN ${game.pin}] Game loop already active, ignoring start request`);
      return;
    }
    console.log(`[PIN ${game.pin}] Starting game loop with ${game.players.length} players (${game.players.filter(p => !p.isHost).length} active players)`);
    this.gameManager.updateGamePhase(game.id, 'preparation');
    game.gameLoopActive = true;
    this.schedulePhase(game, 'preparation', 0);
  }

  stopGameLoop(gameId: string): void {
    this.timerManager.clearAllTimers(gameId);
    this.phaseCallbacks.delete(gameId);
    this.clearHostDisconnectGrace(gameId);
    this.playerManager.clearOptionPermutations(gameId);
    this.lastAnsweredNotifyAt.delete(gameId);
    const game = this.gameManager.getGame(gameId);
    if (game) {
      game.gameLoopActive = false;
      console.log(`[PIN ${game.pin}] Game loop stopped`);
    }
  }

  transitionToPhase(game: Game, phase: GamePhase): void {
    if (!game.gameLoopActive) {
      console.log(`[PIN ${game.pin}] Cannot transition - game loop not active`);
      return;
    }
    this.timerManager.clearAllTimers(game.id);
    console.log(`[PIN ${game.pin}] Manual transition to phase: ${phase}`);
    this.schedulePhase(game, phase, 0);
  }

  /**
   * Phase 2: start a grace window when the host disconnects.
   * If the host doesn't return before HOST_DISCONNECT_GRACE_MS, the game is finished.
   * A reconnecting host (validated via hostToken) should call clearHostDisconnectGrace.
   *
   * Also pauses an in-flight thinking/answering phase: the timer would otherwise keep
   * ticking and advance the question while the host is offline, so the host returns to
   * a leaderboard for a question they never saw scored.
   */
  startHostDisconnectGrace(game: Game): void {
    if (this.hostDisconnectTimers.has(game.id)) return; // already running
    this.pauseForHostDisconnect(game);
    console.log(`[PIN ${game.pin}] Host disconnected — starting ${HOST_DISCONNECT_GRACE_MS / 1000}s grace window`);
    this.io.to(game.id).emit('hostReconnecting', HOST_DISCONNECT_GRACE_MS);
    const t = setTimeout(() => {
      console.log(`[PIN ${game.pin}] Host did not reconnect within grace — finishing game`);
      this.hostDisconnectTimers.delete(game.id);
      // In the lobby the loop is not running yet, and transitionToPhase is a no-op when
      // gameLoopActive=false — the game would linger (and keep its PIN) until idle GC.
      if (game.gameLoopActive) {
        this.transitionToPhase(game, 'finished');
      } else {
        this.executeFinishedPhase(game);
      }
    }, HOST_DISCONNECT_GRACE_MS);
    this.hostDisconnectTimers.set(game.id, t);
  }

  clearHostDisconnectGrace(gameId: string): void {
    const t = this.hostDisconnectTimers.get(gameId);
    if (t) {
      clearTimeout(t);
      this.hostDisconnectTimers.delete(gameId);
      const game = this.gameManager.getGame(gameId);
      if (game) {
        console.log(`[PIN ${game.pin}] Host reconnected — grace cleared`);
        this.io.to(gameId).emit('hostReconnected');
        this.resumeAfterHostReconnect(game);
      }
    }
  }

  /**
   * Pause an in-flight thinking/answering phase. Captures remaining time, clears the
   * phase timer, and suspends the all-answered early-end callback so a player submitting
   * during the gap doesn't accidentally advance to results.
   */
  private pauseForHostDisconnect(game: Game): void {
    if (game.phase !== 'thinking' && game.phase !== 'answering') return;
    const totalMs = game.phase === 'thinking'
      ? game.settings.thinkTime * 1000
      : game.settings.answerTime * 1000 + ANSWER_GRACE_MS;
    const startedAt = game.phase === 'thinking' ? game.phaseStartTime : game.questionStartTime;
    const elapsed = Date.now() - (startedAt || Date.now());
    const remaining = Math.max(0, totalMs - elapsed);
    if (remaining <= 0) return;
    game.pauseRemainingMs = remaining;
    game.pausedPhase = game.phase;
    const timerType = game.phase === 'thinking'
      ? TimerManager.TIMER_TYPES.THINKING_PHASE
      : TimerManager.TIMER_TYPES.ANSWERING_PHASE;
    this.timerManager.clearTimer(game.id, timerType);
    this.phaseCallbacks.set(game.id, null);
    console.log(`[PIN ${game.pin}] Paused ${game.phase} phase (${Math.round(remaining / 1000)}s remaining) on host disconnect`);
  }

  /**
   * Restart a paused phase after the host returns. Bumps qEpoch so answers submitted
   * during the disconnect window (which the client UI should have suppressed via
   * `hostReconnecting`, but we don't trust the client) are rejected as stale.
   *
   * Adjusts phaseStartTime / questionStartTime forward by the pause duration so scoring
   * stays consistent: post-resume answerers get correct response-time math; players who
   * already answered before / during the pause clamp-to-0 → full points (a small bonus
   * for being fast and unlucky enough to coincide with the disconnect).
   */
  private resumeAfterHostReconnect(game: Game): void {
    const remainingMs = game.pauseRemainingMs;
    const phase = game.pausedPhase;
    delete game.pauseRemainingMs;
    delete game.pausedPhase;
    if (!remainingMs || !phase || game.phase !== phase) return;
    const question = this.questionManager.getCurrentQuestion(game);
    if (!question) return;

    game.qEpoch = (game.qEpoch ?? 0) + 1;
    const now = Date.now();
    const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
    const deadlineMs = now + remainingMs;

    if (phase === 'thinking') {
      game.phaseStartTime = now - (game.settings.thinkTime * 1000 - remainingMs);
      const deadline = { serverNow: now, deadlineMs, qEpoch: game.qEpoch, questionIndex: game.currentQuestionIndex };
      if (game.settings.shuffleAnswers) {
        game.players.forEach((p) => {
          if (!p.isConnected) return;
          const q = p.isHost ? question : this.playerManager.getQuestionForPlayer(game, p, question);
          this.io.to(p.socketId).emit('thinkingPhase', q, remainingSec, deadline);
        });
      } else {
        this.emitThinkingPhaseUnshuffled(game, question, remainingSec, deadline);
      }
      this.timerManager.setThinkingPhaseTimer(game.id, () => {
        this.executePhase(game, 'answering');
      }, remainingSec);
      console.log(`[PIN ${game.pin}] Resumed thinking with ${remainingSec}s left (qEpoch=${game.qEpoch})`);
    } else {
      game.questionStartTime = now - (game.settings.answerTime * 1000 - remainingMs);
      game.answerDeadlineMs = deadlineMs;
      this.io.to(game.id).emit('answeringPhase', remainingSec, {
        serverNow: now,
        deadlineMs,
        qEpoch: game.qEpoch,
        questionIndex: game.currentQuestionIndex,
      });
      this.timerManager.setAnsweringPhaseTimer(game.id, () => {
        console.log(`[PIN ${game.pin}] Answering time + grace expired, moving to results`);
        this.executePhase(game, 'results');
      }, remainingSec);
      this.phaseCallbacks.set(game.id, () => {
        const ap = game.players.filter(p => !p.isHost && p.isConnected);
        if (ap.length > 0 && this.questionManager.hasAllPlayersAnswered(game)) {
          console.log(`[PIN ${game.pin}] All players answered (post-resume), ending answering phase early`);
          this.timerManager.clearTimer(game.id, TimerManager.TIMER_TYPES.ANSWERING_PHASE);
          this.executePhase(game, 'results');
        }
      });
      console.log(`[PIN ${game.pin}] Resumed answering with ${remainingSec}s left (qEpoch=${game.qEpoch})`);
    }
  }

  /**
   * Unshuffled thinkingPhase: one room broadcast of the key-stripped question for players,
   * plus the full question to the host socket (projector view / results highlighting).
   */
  private emitThinkingPhaseUnshuffled(game: Game, question: Question, seconds: number, deadline: PhaseDeadline): void {
    const host = this.playerManager.getHost(game);
    const stripped: Question = { ...question, correctAnswer: -1 };
    delete stripped.correctAnswers;
    if (host && host.isConnected) {
      this.io.to(game.id).except(host.socketId).emit('thinkingPhase', stripped, seconds, deadline);
      this.io.to(host.socketId).emit('thinkingPhase', question, seconds, deadline);
    } else {
      this.io.to(game.id).emit('thinkingPhase', stripped, seconds, deadline);
    }
  }

  private schedulePhase(game: Game, phase: GamePhase, delay: number): void {
    const timerType = `phase_${phase}`;
    this.timerManager.setTimer(game.id, timerType, () => {
      this.executePhase(game, phase);
    }, delay);
    if (delay > 0) {
      console.log(`[PIN ${game.pin}] Scheduled phase ${phase} with delay ${delay}ms`);
    }
  }

  private executePhase(game: Game, phase: GamePhase): void {
    console.log(`[PIN ${game.pin}] Phase: ${phase} | Question: ${game.currentQuestionIndex + 1}/${game.questions.length} | Players: ${game.players.filter(p => !p.isHost && p.isConnected).length}`);
    this.timerManager.clearTimersWithPrefix(game.id, RESYNC_TIMER_PREFIX);
    this.gameManager.updateGamePhase(game.id, phase);
    game.phaseStartTime = Date.now();
    this.gameManager.markActive(game.id); // Phase 5: idle GC
    switch (phase) {
      case 'preparation': this.executePreprationPhase(game); break;
      case 'thinking':    this.executeThinkingPhase(game); break;
      case 'answering':   this.executeAnsweringPhase(game); break;
      case 'results':     this.executeResultsPhase(game); break;
      case 'leaderboard': this.executeLeaderboardPhase(game); break;
      case 'finished':    this.executeFinishedPhase(game); break;
      default:
        console.error(`❌ [PIN ${game.pin}] Unknown phase: ${phase}`);
    }
  }

  private executePreprationPhase(game: Game): void {
    if (game.currentQuestionIndex >= 0) {
      this.playerManager.storeAnswersToHistory(game);
      console.log(`[PIN ${game.pin}] Stored answer history for question ${game.currentQuestionIndex}`);
    }
    this.playerManager.clearAnswers(game);
    const question = this.questionManager.startNextQuestion(game);
    if (!question) {
      console.log(`[PIN ${game.pin}] No more questions, finishing game`);
      this.schedulePhase(game, 'finished', 100);
      return;
    }
    this.schedulePhase(game, 'thinking', 500);
  }

  private executeThinkingPhase(game: Game): void {
    const question = this.questionManager.getCurrentQuestion(game);
    if (!question) {
      console.error(`❌ [PIN ${game.pin}] No current question for game`);
      return;
    }
    console.log(`[PIN ${game.pin}] Thinking phase | Question: "${question.question.substring(0, 30)}${question.question.length > 30 ? '...' : ''}" | Duration: ${game.settings.thinkTime}s`);
    // Phase 6: bump qEpoch, send absolute deadline
    game.qEpoch = (game.qEpoch ?? 0) + 1;
    const now = Date.now();
    const deadlineMs = now + game.settings.thinkTime * 1000;
    const deadline = { serverNow: now, deadlineMs, qEpoch: game.qEpoch, questionIndex: game.currentQuestionIndex };
    if (game.settings.shuffleAnswers) {
      // Per-player shuffled emit. Host gets the canonical order (projector view).
      game.players.forEach((p) => {
        if (!p.isConnected) return;
        const q = p.isHost ? question : this.playerManager.getQuestionForPlayer(game, p, question);
        this.io.to(p.socketId).emit('thinkingPhase', q, game.settings.thinkTime, deadline);
      });
    } else {
      this.emitThinkingPhaseUnshuffled(game, question, game.settings.thinkTime, deadline);
    }
    this.timerManager.setThinkingPhaseTimer(game.id, () => {
      this.executePhase(game, 'answering');
    }, game.settings.thinkTime);
  }

  private executeAnsweringPhase(game: Game): void {
    const activePlayers = game.players.filter(p => !p.isHost && p.isConnected);
    console.log(`[PIN ${game.pin}] Answering phase | Duration: ${game.settings.answerTime}s | Active players: ${activePlayers.length}`);
    const now = Date.now();
    this.gameManager.setQuestionStartTime(game.id, now);
    // Phase 6: bump qEpoch + send absolute deadline. Server-side accept window = deadline + grace.
    game.qEpoch = (game.qEpoch ?? 0) + 1;
    const deadlineMs = now + game.settings.answerTime * 1000;
    game.answerDeadlineMs = deadlineMs + ANSWER_GRACE_MS;
    this.io.to(game.id).emit('answeringPhase', game.settings.answerTime, {
      serverNow: now,
      deadlineMs,
      qEpoch: game.qEpoch,
      questionIndex: game.currentQuestionIndex,
    });
    // Server expires phase at deadline + grace so late submissions still land
    // setAnsweringPhaseTimer expects seconds; we add 1s grace (ANSWER_GRACE_MS = 1000)
    this.timerManager.setAnsweringPhaseTimer(game.id, () => {
      console.log(`[PIN ${game.pin}] Answering time + grace expired, moving to results`);
      this.executePhase(game, 'results');
    }, game.settings.answerTime + Math.ceil(ANSWER_GRACE_MS / 1000));
    this.phaseCallbacks.set(game.id, () => {
      const ap = game.players.filter(p => !p.isHost && p.isConnected);
      if (ap.length > 0 && this.questionManager.hasAllPlayersAnswered(game)) {
        console.log(`[PIN ${game.pin}] All players answered, ending answering phase early`);
        this.timerManager.clearTimer(game.id, TimerManager.TIMER_TYPES.ANSWERING_PHASE);
        this.executePhase(game, 'results');
      }
    });
  }

  private executeResultsPhase(game: Game): void {
    const currentQuestion = this.questionManager.getCurrentQuestion(game);
    if (!currentQuestion) {
      console.error(`❌ [PIN ${game.pin}] No current question for results phase`);
      return;
    }
    this.playerManager.updateScores(game, currentQuestion);
    const stats = this.questionManager.getQuestionStats(game);
    if (stats) {
      const correctAnswerCount = stats.answers.find(a => a.optionIndex === currentQuestion.correctAnswer)?.count || 0;
      console.log(`[PIN ${game.pin}] Results | Correct: ${correctAnswerCount}/${stats.totalPlayers}`);
      // Players: bare signal + their own result (which carries the answer key in their
      // option order). Host: the full stats. The old room broadcast of `stats` shipped
      // the answer key and every option's counts to 200 phones that never rendered them.
      this.io.to(game.id).emit('questionEnded');
      const host = this.playerManager.getHost(game);
      if (host && host.isConnected) {
        this.io.to(host.socketId).emit('hostResults', stats);
      }
      const personalResults = this.questionManager.getPersonalResults(game);
      game.players.forEach((player) => {
        if (player.isHost || !player.isConnected) return;
        const personalResult = personalResults.get(player.id);
        if (personalResult) {
          const view = this.playerManager.getShuffledQuestionForPlayer(game, player, currentQuestion);
          personalResult.correctAnswer = view.correctAnswer;
          if (view.correctAnswers) personalResult.correctAnswers = view.correctAnswers;
          this.io.to(player.socketId).emit('personalResult', personalResult);
        }
      });
    }
    this.phaseCallbacks.set(game.id, null);
    console.log(`[PIN ${game.pin}] Waiting for host to continue to leaderboard`);
  }

  private executeLeaderboardPhase(game: Game): void {
    const leaderboard = this.playerManager.applyCompetitionRanks(this.playerManager.getLeaderboard(game));
    const topPlayer = leaderboard[0] || null;
    console.log(`[PIN ${game.pin}] Leaderboard | Top: ${topPlayer ? `${topPlayer.name} (${topPlayer.score})` : 'none'}`);
    const gameLite = sanitizeGameForClient(game, { players: false });
    const host = this.playerManager.getHost(game);
    const top = leaderboard.slice(0, LEADERBOARD_TOP_N).map(toPublicPlayer);
    if (host && host.isConnected) {
      this.io.to(host.socketId).emit('leaderboardShown', leaderboard.map(toPublicPlayer), gameLite);
      this.io.to(game.id).except(host.socketId).emit('leaderboardShown', top, gameLite);
    } else {
      this.io.to(game.id).emit('leaderboardShown', top, gameLite);
    }
    leaderboard.forEach((p) => {
      if (!p.isConnected) return;
      this.io.to(p.socketId).emit('myStanding', this.standingFor(p, leaderboard.length));
    });
  }

  private standingFor(p: Player, total: number): PlayerStanding {
    return { rank: p.rank ?? 0, score: p.score, total, name: p.name };
  }

  private executeFinishedPhase(game: Game): void {
    // Score the current question if it hasn't been scored yet (idempotent via game.scoredQuestions).
    // Covers: endGame from non-results phases, idle-GC auto-finish, host-disconnect-timeout. Without
    // this the final question's points never make it into player.score / players.final_score.
    if (game.currentQuestionIndex >= 0) {
      const currentQuestion = this.questionManager.getCurrentQuestion(game);
      if (currentQuestion) {
        this.playerManager.updateScores(game, currentQuestion);
      }
      this.playerManager.storeAnswersToHistory(game);
    }
    this.gameManager.updateGamePhase(game.id, 'finished');
    const finalResults = this.playerManager.applyCompetitionRanks(this.playerManager.getFinalResults(game));
    const winner = finalResults[0] || null;
    console.log(`[PIN ${game.pin}] Game finished | Winner: ${winner ? `${winner.name} (${winner.score})` : 'none'}`);
    this.io.to(game.id).emit('gameFinished', finalResults.map(toPublicPlayer));
    this.stopGameLoop(game.id);
    // Phase 4: generate + persist TSV once, then drop from memory. Game stays in SQLite
    // for downloads / leaderboards until the 366-day retention sweep.
    try {
      const tsv = this.playerManager.generateGameLogsTSV(game);
      dbFinishGame(game.id, tsv, finalResults);
    } catch (e) {
      console.error('[db] finishGame failed:', e);
    }
    // Drop in-memory state after a short grace so straggler events (e.g. final TSV download
    // attempt via in-memory path) succeed. DB still has it after this.
    this.timerManager.setTimer(game.id, 'game_cleanup', () => {
      console.log(`[PIN ${game.pin}] Releasing in-memory state (DB record preserved)`);
      this.gameManager.deleteGame(game.id);
    }, 60_000);
  }

  onPlayerAnswered(game: Game): void {
    this.notifyHostAnswered(game);
    const callback = this.phaseCallbacks.get(game.id);
    if (callback && game.phase === 'answering') {
      callback();
    }
  }

  /**
   * Send the host (only) the current answered/total count, at most once per
   * ANSWERED_NOTIFY_MIN_INTERVAL_MS. Leading edge fires immediately; a burst inside the
   * window schedules one trailing emit carrying the latest count.
   */
  private notifyHostAnswered(game: Game): void {
    const now = Date.now();
    const last = this.lastAnsweredNotifyAt.get(game.id) ?? 0;
    const elapsed = now - last;
    if (elapsed >= ANSWERED_NOTIFY_MIN_INTERVAL_MS) {
      this.emitAnsweredCount(game);
      return;
    }
    // setTimer replaces any pending timer of the same type, so only one trailing emit exists.
    this.timerManager.setTimer(game.id, ANSWERED_NOTIFY_TIMER, () => {
      if (game.phase === 'answering') this.emitAnsweredCount(game);
    }, ANSWERED_NOTIFY_MIN_INTERVAL_MS - elapsed);
  }

  private emitAnsweredCount(game: Game): void {
    const host = this.playerManager.getHost(game);
    const answeredCount = this.questionManager.getAnsweredPlayerCount(game);
    const totalPlayers = game.players.filter(p => !p.isHost && p.isConnected).length;
    this.lastAnsweredNotifyAt.set(game.id, Date.now());
    if (host && host.isConnected) {
      this.io.to(host.socketId).emit('playerAnswered', answeredCount, totalPlayers);
    }
  }

  /**
   * Sync a newly connected socket to the current game phase.
   *
   * Phase 2 gating: only `isHost` or `isKnownPlayer` connections receive the
   * live question during thinking/answering. Anyone else (new socket, no token,
   * not in game.players) gets a `waitForNextQuestion` event — kills the
   * second-tab-cheat path.
   */
  syncPlayerToCurrentPhase(
    game: Game,
    socketId: string,
    isHost: boolean,
    isKnownPlayer: boolean = false
  ): void {
    if (!game.gameLoopActive) return;
    const trusted = isHost || isKnownPlayer;
    const playerType = isHost ? 'Host' : isKnownPlayer ? 'Returning player' : 'Unknown';
    const currentQuestionLabel = game.currentQuestionIndex >= 0
      ? `Question ${game.currentQuestionIndex + 1}/${game.questions.length}`
      : 'No question';
    console.log(`[PIN ${game.pin}] ${playerType} connecting | Phase: ${game.phase} | ${currentQuestionLabel}`);

    switch (game.phase) {
      case 'thinking': {
        if (!trusted) {
          this.io.to(socketId).emit('waitForNextQuestion');
          return;
        }
        const question = this.questionManager.getCurrentQuestion(game);
        if (question) {
          const now = Date.now();
          const deadlineMs = (game.phaseStartTime || now) + game.settings.thinkTime * 1000;
          const remaining = Math.max(0, Math.floor((deadlineMs - now) / 1000));
          if (remaining > 0) {
            // Shuffle to this specific player's permutation if shuffleAnswers is on.
            const player = isHost ? undefined : game.players.find((p) => p.socketId === socketId);
            const q = (player && !isHost)
              ? this.playerManager.getQuestionForPlayer(game, player, question)
              : question;
            // Phase 6: include the deadline payload so the reconnecting client can compute
            // clock skew and qEpoch protects against stale submissions.
            this.io.to(socketId).emit('thinkingPhase', q, remaining, {
              serverNow: now,
              deadlineMs,
              qEpoch: game.qEpoch ?? 0,
              questionIndex: game.currentQuestionIndex,
            });
          }
        }
        break;
      }
      case 'answering': {
        if (!trusted) {
          this.io.to(socketId).emit('waitForNextQuestion');
          return;
        }
        const currentQuestion = this.questionManager.getCurrentQuestion(game);
        if (currentQuestion) {
          // Briefly show the thinking screen with full deadline payload so the client wires
          // up timer + qEpoch consistently before flipping to answering.
          const thinkNow = Date.now();
          const thinkDeadline = thinkNow + game.settings.thinkTime * 1000;
          const player = isHost ? undefined : game.players.find((p) => p.socketId === socketId);
          const q = (player && !isHost)
            ? this.playerManager.getQuestionForPlayer(game, player, currentQuestion)
            : currentQuestion;
          this.io.to(socketId).emit('thinkingPhase', q, game.settings.thinkTime, {
            serverNow: thinkNow,
            deadlineMs: thinkDeadline,
            qEpoch: game.qEpoch ?? 0,
            questionIndex: game.currentQuestionIndex,
          });
          // The follow-up answeringPhase emit is deferred so the client processes the
          // thinkingPhase first. It is registered with TimerManager (cleared on any phase
          // transition) AND re-checks phase + qEpoch when it fires: an unguarded emit
          // landing after 'results' left the host stuck on the answering screen.
          const qEpochAtSync = game.qEpoch ?? 0;
          const delay = isHost ? 250 : 100;
          this.timerManager.setTimer(game.id, `${RESYNC_TIMER_PREFIX}${socketId}`, () => {
            if (game.phase !== 'answering' || (game.qEpoch ?? 0) !== qEpochAtSync) return;
            const now = Date.now();
            const deadlineMs = (game.questionStartTime || now) + game.settings.answerTime * 1000;
            const remaining = Math.max(0, Math.floor((deadlineMs - now) / 1000));
            if (remaining > 0) {
              this.io.to(socketId).emit('answeringPhase', remaining, {
                serverNow: now,
                deadlineMs,
                qEpoch: qEpochAtSync,
                questionIndex: game.currentQuestionIndex,
              });
            }
          }, delay);
        }
        break;
      }
      case 'leaderboard': {
        const leaderboard = this.playerManager.applyCompetitionRanks(this.playerManager.getLeaderboard(game));
        const gameLite = sanitizeGameForClient(game, { players: false });
        if (isHost) {
          this.io.to(socketId).emit('leaderboardShown', leaderboard.map(toPublicPlayer), gameLite);
        } else {
          this.io.to(socketId).emit('leaderboardShown', leaderboard.slice(0, LEADERBOARD_TOP_N).map(toPublicPlayer), gameLite);
          const me = game.players.find((p) => p.socketId === socketId);
          if (me && !me.isHost) this.io.to(socketId).emit('myStanding', this.standingFor(me, leaderboard.length));
        }
        break;
      }
      case 'finished': {
        const finalResults = this.playerManager.applyCompetitionRanks(this.playerManager.getFinalResults(game));
        this.io.to(socketId).emit('gameFinished', finalResults.map(toPublicPlayer));
        break;
      }
      // waiting / preparation / results: nothing special to sync
    }
  }
}
