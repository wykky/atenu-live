import { v4 as uuidv4 } from 'uuid';
import type { Game, Player, Question, AnswerRecord } from '@/types/game';
import { issuePlayerToken, verifyPlayerToken } from './tokens';
import { upsertPlayer, insertAnswer, updatePlayerScore, runInTransaction } from '@/lib/db';
import {
  isMultiSelect,
  isAnswerCorrect,
  serializeSubmission,
  parseAnswerIndices,
  getCorrectAnswerArray,
} from './questionType';

// Phase 8: adaptive scoring trust window — accept client-reported time if within 2s of server-measured.
const TRUST_WINDOW_MS = 2000;
// Kahoot-style 500-pt floor for correct answers: 1000*(1-r/2) — 1000 at t=0, 500 at deadline.
// On 3G, this stops penalizing students who answered correctly but slowly into ~0 points territory.
const MAX_POINTS_PER_QUESTION = 1000;
// Dyslexia accessibility: reduce the time penalty fraction by 20% before applying the /2 floor.
const DYSLEXIA_TIME_PENALTY_MULTIPLIER = 0.8;
// Streak/combo bonus: matches Kahoot's pattern. Streak 1 = no bonus (first correct, no chain yet),
// streak 2 = +100, ..., streak 6+ = +500 capped. Reset to 0 on any wrong / no answer.
const STREAK_BONUS_PER_STEP = 100;
const STREAK_BONUS_MAX = 500;
// Flat bonus for the player who submitted the earliest correct answer on a question.
const FIRST_CORRECT_BONUS = 100;

function streakBonusFor(streak: number): number {
  return Math.min(STREAK_BONUS_MAX, Math.max(0, (streak - 1) * STREAK_BONUS_PER_STEP));
}

/**
 * Canonical scoring math — single source of truth for "how many points did this player
 * earn on this question". Called once per (player, question) by updateScores. Result is
 * cached on player.lastPointsEarned so storeAnswersToHistory and getPersonalResult can
 * read the same number without recomputing (and without drifting from each other).
 */
export function computeQuestionPoints(player: Player, game: Game, question: Question): number {
  if (player.isHost) return 0;
  if (player.currentAnswer === undefined) return 0;
  // Strict correctness — works for both single-select and multi-select.
  if (!isAnswerCorrect(question, player.currentAnswer)) return 0;

  const questionStartTime = game.questionStartTime || Date.now();
  const answerTimeLimit = game.settings.answerTime * 1000;

  const serverResponseMs = (player.answerTime || Date.now()) - questionStartTime;
  let scoringResponseMs = serverResponseMs;
  if (
    typeof player.perceivedResponseMs === 'number' &&
    player.perceivedResponseMs >= 0 &&
    Math.abs(serverResponseMs - player.perceivedResponseMs) <= TRUST_WINDOW_MS
  ) {
    scoringResponseMs = player.perceivedResponseMs;
  }

  const timeUsedRatio = Math.max(0, Math.min(1, scoringResponseMs / answerTimeLimit));
  const adjusted = player.hasDyslexiaSupport
    ? timeUsedRatio * DYSLEXIA_TIME_PENALTY_MULTIPLIER
    : timeUsedRatio;

  return Math.max(0, Math.round(MAX_POINTS_PER_QUESTION * (1 - adjusted / 2)));
}

export interface JoinGameResult {
  success: boolean;
  game?: Game;
  playerId?: string;
  playerToken?: string;
  isReconnection?: boolean;
  reason?: string; // diagnostic for debug logs
  kickedSocketId?: string; // Phase 7: the OLD socket holding this player's identity, to be kicked
}

export class PlayerManager {
  // Per-game per-player per-question option permutations. Key: "playerId:questionIndex".
  // Generated lazily on first emit to the player; consumed by translateAnswerIndex on submit.
  // Lives only in memory — regenerated if the player reconnects on a fresh server.
  private optionPermutations = new Map<string, Map<string, number[]>>();

  private getOrCreatePermutation(gameId: string, playerId: string, questionIndex: number, optionCount: number): number[] {
    let gameMap = this.optionPermutations.get(gameId);
    if (!gameMap) {
      gameMap = new Map();
      this.optionPermutations.set(gameId, gameMap);
    }
    const key = `${playerId}:${questionIndex}`;
    let perm = gameMap.get(key);
    if (!perm) {
      // Fisher-Yates. Math.random is fine here — this is anti-peek, not crypto.
      perm = Array.from({ length: optionCount }, (_, i) => i);
      for (let i = perm.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [perm[i], perm[j]] = [perm[j]!, perm[i]!];
      }
      gameMap.set(key, perm);
    }
    return perm;
  }

  /**
   * Returns a question with options reordered for this player. Caller must use this
   * when settings.shuffleAnswers is true; otherwise just pass the canonical question.
   *
   * The permutation `perm[i] = j` means "shuffled slot i holds canonical option j".
   * To keep correctAnswer / correctAnswers consistent with the shuffled options array
   * (so the results screen can highlight the right cells), we translate every
   * canonical correct index `j` to the shuffled slot `perm.indexOf(j)`. Without this
   * step, the client receives options in shuffled order but correctAnswer in canonical
   * order, and the results UI highlights whatever option happens to sit at the
   * canonical correct index — the visible-but-wrong "Cairo is correct? No, Alexandria!"
   * bug.
   */
  getShuffledQuestionForPlayer(game: Game, player: Player, question: Question): Question {
    if (!game.settings.shuffleAnswers) return question;
    const perm = this.getOrCreatePermutation(game.id, player.id, game.currentQuestionIndex, question.options.length);
    const shuffledOptions = perm.map((i) => question.options[i]!);
    const shuffledCorrectAnswer = perm.indexOf(question.correctAnswer);
    const shuffledCorrectAnswers = question.correctAnswers
      ? question.correctAnswers.map((j) => perm.indexOf(j)).sort((a, b) => a - b)
      : undefined;
    return {
      ...question,
      options: shuffledOptions,
      correctAnswer: shuffledCorrectAnswer >= 0 ? shuffledCorrectAnswer : question.correctAnswer,
      correctAnswers: shuffledCorrectAnswers,
    };
  }

  /**
   * What a PLAYER's phone receives during thinking/answering: the (optionally shuffled)
   * question WITHOUT its answer key. correctAnswer is -1 and correctAnswers is dropped;
   * the real values for this player's order are revealed in personalResult. Before this,
   * any student could read the answer out of the socket frame in devtools.
   */
  getQuestionForPlayer(game: Game, player: Player, question: Question): Question {
    const q = this.getShuffledQuestionForPlayer(game, player, question);
    const stripped: Question = { ...q, correctAnswer: -1 };
    delete stripped.correctAnswers;
    return stripped;
  }

  /**
   * Map a player's "what they clicked" index (in their shuffled space) back to the
   * canonical option index used by question.correctAnswer.
   */
  translateAnswerIndex(game: Game, player: Player, clickedIndex: number): number {
    if (!game.settings.shuffleAnswers) return clickedIndex;
    const gameMap = this.optionPermutations.get(game.id);
    const perm = gameMap?.get(`${player.id}:${game.currentQuestionIndex}`);
    if (!perm) return clickedIndex; // No perm yet (shouldn't happen — emit always precedes submit)
    return perm[clickedIndex] ?? clickedIndex;
  }

  /**
   * Multi-select counterpart: translate every clicked index through the per-player
   * permutation. Returns a deduped, sorted canonical array suitable for storage
   * on player.currentAnswer.
   */
  translateAnswerIndices(game: Game, player: Player, clickedIndices: number[]): number[] {
    if (!game.settings.shuffleAnswers) {
      return Array.from(new Set(clickedIndices)).sort((a, b) => a - b);
    }
    const gameMap = this.optionPermutations.get(game.id);
    const perm = gameMap?.get(`${player.id}:${game.currentQuestionIndex}`);
    if (!perm) return Array.from(new Set(clickedIndices)).sort((a, b) => a - b);
    return Array.from(new Set(clickedIndices.map((i) => perm[i] ?? i))).sort((a, b) => a - b);
  }

  clearOptionPermutations(gameId: string): void {
    this.optionPermutations.delete(gameId);
  }

  /**
   * Phase 2: joinGame requires a playerToken for reconnection.
   * - persistentId without a valid token → treated as a new join (rejected if mid-game)
   * - persistentId WITH valid token → reconnection, updates socketId & marks connected
   * - no persistentId → fresh join in waiting phase only, issues a new playerToken
   */
  joinGame(
    game: Game,
    socketId: string,
    playerName: string,
    persistentId: string | null = null,
    playerToken: string | null = null,
    userId: string | null = null
  ): JoinGameResult {
    // Reconnection attempt
    if (persistentId) {
      const existingPlayer = game.players.find((p) => p.id === persistentId);
      if (existingPlayer && !existingPlayer.isHost) {
        if (!playerToken || !verifyPlayerToken(playerToken, game.id, persistentId)) {
          return { success: false, reason: 'invalid playerToken on reconnect' };
        }
        // Phase 7: single-active-session lock — capture old socketId so the previous tab can be kicked
        const kickedSocketId =
          existingPlayer.socketId && existingPlayer.socketId !== socketId
            ? existingPlayer.socketId
            : undefined;
        existingPlayer.socketId = socketId;
        existingPlayer.isConnected = true;
        // Phase 4: refresh DB record (link userId if newly signed in)
        try { upsertPlayer(game.id, existingPlayer, userId); } catch (e) { console.error('[db] upsertPlayer failed:', e); }
        return {
          success: true,
          game,
          playerId: persistentId,
          playerToken,
          isReconnection: true,
          kickedSocketId,
        };
      }
      // persistentId provided but no matching player → fall through to fresh join
    }

    // Fresh join — only during waiting phase
    if (game.status !== 'waiting') {
      return { success: false, reason: 'game not in waiting phase' };
    }

    // Reject duplicate names (active OR disconnected, NFC-normalized)
    const normalized = playerName.normalize('NFC').trim();
    if (game.players.some((p) => !p.isHost && p.name.normalize('NFC').trim() === normalized)) {
      return { success: false, reason: 'name taken' };
    }

    const playerId = uuidv4();
    const newPlayer: Player = {
      id: playerId,
      socketId,
      name: normalized,
      score: 0,
      isHost: false,
      isConnected: true,
    };
    game.players.push(newPlayer);
    // Phase 4: persist new player
    try { upsertPlayer(game.id, newPlayer, userId); } catch (e) { console.error('[db] upsertPlayer failed:', e); }
    return {
      success: true,
      game,
      playerId,
      playerToken: issuePlayerToken(game.id, playerId),
      isReconnection: false,
    };
  }

  disconnectPlayer(socketId: string, game: Game): Player | undefined {
    const player = game.players.find((p) => p.socketId === socketId);
    if (player) {
      player.isConnected = false;
      return player;
    }
    return undefined;
  }

  removePlayer(playerId: string, game: Game): boolean {
    const idx = game.players.findIndex((p) => p.id === playerId);
    if (idx !== -1) {
      const player = game.players[idx];
      game.players.splice(idx, 1);
      console.log(`[PIN ${game.pin}] Removed player ${player.name} (${player.id})`);
      return true;
    }
    return false;
  }

  getPlayerBySocketId(socketId: string, game: Game): Player | undefined {
    return game.players.find((p) => p.socketId === socketId);
  }

  getPlayerById(playerId: string, game: Game): Player | undefined {
    return game.players.find((p) => p.id === playerId);
  }

  getConnectedPlayers(game: Game): Player[] {
    return game.players.filter((p) => p.isConnected && !p.isHost);
  }

  getHost(game: Game): Player | undefined {
    return game.players.find((p) => p.isHost);
  }

  isHost(socketId: string, game: Game): boolean {
    const p = this.getPlayerBySocketId(socketId, game);
    return p?.isHost ?? false;
  }

  submitAnswer(
    game: Game,
    playerId: string,
    answer: number | number[],
    isPersistentId: boolean = false,
    clientPerceivedMs?: number
  ): boolean {
    const player = isPersistentId
      ? this.getPlayerById(playerId, game)
      : this.getPlayerBySocketId(playerId, game);
    if (!player || player.isHost) return false;
    if (player.currentAnswer !== undefined) return false; // no double answers

    const question = game.questions[game.currentQuestionIndex];
    const wantsMulti = question ? isMultiSelect(question) : Array.isArray(answer);

    if (wantsMulti) {
      // Coerce single-number submissions to single-element array for shape consistency.
      const submitted = Array.isArray(answer) ? answer : [answer];
      // Translate from player's shuffled space to canonical (no-op if shuffleAnswers is off)
      player.currentAnswer = this.translateAnswerIndices(game, player, submitted);
    } else {
      // Single-select: clients on stale builds may still send arrays — accept the first.
      const single = Array.isArray(answer) ? answer[0] : answer;
      if (typeof single !== 'number') return false;
      player.currentAnswer = this.translateAnswerIndex(game, player, single);
    }
    player.answerTime = Date.now();
    if (typeof clientPerceivedMs === 'number' && clientPerceivedMs >= 0) {
      player.perceivedResponseMs = clientPerceivedMs; // Phase 8: adaptive scoring input
    }
    return true;
  }

  clearAnswers(game: Game): void {
    game.players.forEach((player) => {
      if (!player.isHost) {
        delete player.currentAnswer;
        delete player.answerTime;
        delete player.perceivedResponseMs;
        delete player.lastPointsEarned;
        // streakBonus / firstCorrectBonus reset by next updateScores so they reflect
        // the just-scored question while results phase is showing; don't clear here.
        // currentStreak intentionally persists across clearAnswers.
      }
    });
  }

  /**
   * Canonical scoring step. Idempotent via game.scoredQuestions — safe to call from
   * executeResultsPhase (the normal path) AND executeFinishedPhase (the safety net for
   * endGame-from-non-results / idle-GC / host-disconnect-timeout, which otherwise leaves
   * the final question unscored). Computes points once and caches on player.lastPointsEarned
   * so storeAnswersToHistory / getPersonalResult read the same number.
   */
  updateScores(game: Game, question: Question): void {
    if (!game.scoredQuestions) game.scoredQuestions = [];
    if (game.scoredQuestions.includes(game.currentQuestionIndex)) return;
    game.scoredQuestions.push(game.currentQuestionIndex);

    // First-correct: the earliest correct submitter. Use server-measured answerTime
    // (not perceived) since perceived is a client-reported value, vulnerable to spoofing.
    const correctPlayers = game.players.filter(
      (p) => !p.isHost && isAnswerCorrect(question, p.currentAnswer) && p.answerTime !== undefined
    );
    correctPlayers.sort((a, b) => (a.answerTime ?? Infinity) - (b.answerTime ?? Infinity));
    const firstCorrectId = correctPlayers[0]?.id;
    // DB writes are collected and flushed in ONE transaction below (one fsync instead of
    // one per player; 200 players = 200 autocommits per question before).
    const scoreWrites: Player[] = [];

    game.players.forEach((player) => {
      if (player.isHost) return;
      const basePoints = computeQuestionPoints(player, game, question);
      const wasCorrect = basePoints > 0;

      if (wasCorrect) {
        const newStreak = (player.currentStreak ?? 0) + 1;
        const streakBonus = streakBonusFor(newStreak);
        const firstCorrectBonus = player.id === firstCorrectId ? FIRST_CORRECT_BONUS : 0;
        const totalEarned = basePoints + streakBonus + firstCorrectBonus;
        player.currentStreak = newStreak;
        player.streakBonus = streakBonus;
        player.firstCorrectBonus = firstCorrectBonus;
        player.lastPointsEarned = totalEarned;
        player.score += totalEarned;
        const supportStatus = player.hasDyslexiaSupport ? ' (with dyslexia support)' : '';
        const serverResponseMs = (player.answerTime || Date.now()) - (game.questionStartTime || Date.now());
        const usedClient =
          typeof player.perceivedResponseMs === 'number' &&
          player.perceivedResponseMs >= 0 &&
          Math.abs(serverResponseMs - player.perceivedResponseMs) <= TRUST_WINDOW_MS &&
          player.perceivedResponseMs !== serverResponseMs;
        const streakTag = streakBonus > 0 ? ` [streak ${newStreak} +${streakBonus}]` : '';
        const firstTag = firstCorrectBonus > 0 ? ` [first +${firstCorrectBonus}]` : '';
        console.log(`[PIN ${game.pin}] ${player.name} +${totalEarned}${supportStatus}${usedClient ? ' [client-time]' : ''}${streakTag}${firstTag} | Total: ${player.score}`);
        scoreWrites.push(player);
      } else {
        // Wrong / no answer breaks the streak. Cache 0 so getPersonalResult shows
        // the +0 outcome consistently with TSV row.
        player.currentStreak = 0;
        player.streakBonus = 0;
        player.firstCorrectBonus = 0;
        player.lastPointsEarned = 0;
      }
    });
    if (scoreWrites.length > 0) {
      try {
        runInTransaction(() => {
          scoreWrites.forEach((p) => updatePlayerScore(game.id, p.id, p.score));
        });
      } catch (e) { console.error('[db] updatePlayerScore batch failed:', e); }
    }
  }

  storeAnswersToHistory(game: Game): void {
    const question = game.questions[game.currentQuestionIndex];
    if (!question) return;
    // Idempotent on (game, questionIndex): the natural path calls this once per question
    // in executePreprationPhase, and executeFinishedPhase also calls it for the final
    // question. Without the guard, the last question's records double up after clearAnswers
    // (the second pass sees player.currentAnswer = undefined and writes an empty row).
    if (game.answerHistory.some((r) => r.questionIndex === game.currentQuestionIndex)) {
      return;
    }
    const questionStartTime = game.questionStartTime || Date.now();
    const newRecords: AnswerRecord[] = [];

    game.players.forEach((player) => {
      if (player.isHost) return;
      const responseTime = player.answerTime ? player.answerTime - questionStartTime : 0;
      const wasCorrect = isAnswerCorrect(question, player.currentAnswer);
      // Read the canonical points from updateScores. If updateScores didn't run for some
      // reason (shouldn't happen — executeResultsPhase or executeFinishedPhase always calls
      // it first), default to 0 rather than recomputing with a different formula.
      const pointsEarned = player.lastPointsEarned ?? 0;
      const record = {
        playerId: player.id,
        playerName: player.name,
        questionIndex: game.currentQuestionIndex,
        questionId: question.id,
        // Single → number, multi → "0,2" comma-joined, none → null
        answerIndex: serializeSubmission(player.currentAnswer),
        answerTime: player.answerTime,
        responseTime,
        pointsEarned,
        wasCorrect,
        hasDyslexiaSupport: player.hasDyslexiaSupport || false,
      };
      game.answerHistory.push(record);
      newRecords.push(record);
    });
    if (newRecords.length > 0) {
      try {
        runInTransaction(() => { newRecords.forEach((r) => insertAnswer(game.id, r)); });
      } catch (e) { console.error('[db] insertAnswer batch failed:', e); }
    }
  }

  /**
   * Tie-aware competition ranking (1, 1, 3, 4, 5, 5, 7). Mutates `rank` on each player.
   * Assumes the input list is already sorted by score DESC (use getLeaderboard).
   */
  applyCompetitionRanks(players: Player[]): Player[] {
    let lastRank = 0;
    let lastScore = Number.POSITIVE_INFINITY;
    players.forEach((p, idx) => {
      if (p.score !== lastScore) {
        lastRank = idx + 1;
        lastScore = p.score;
      }
      p.rank = lastRank;
    });
    return players;
  }

  getLeaderboard(game: Game): Player[] {
    return game.players.filter((p) => !p.isHost).sort((a, b) => b.score - a.score);
  }

  getFinalResults(game: Game): Player[] {
    return this.getLeaderboard(game);
  }

  generateGameLogsTSV(game: Game): string {
    const headers = [
      'question_index',
      'question_datetime',
      'question_type', // 'single' or 'multi'
      'question_string',
      'proposition_correct', // pipe-separated " | " for multi-select
      'proposition_wrong1',
      'proposition_wrong2',
      'proposition_wrong3',
      'question_explanation',
      'player_id',
      'player_nickname',
      'choice_string', // pipe-separated " | " when player picked multiple
      'choice_datetime',
      'has_dyslexia_support',
    ];
    const rows: string[] = [headers.join('\t')];
    const sortedAnswers = [...game.answerHistory].sort((a, b) => {
      if (a.questionIndex !== b.questionIndex) return a.questionIndex - b.questionIndex;
      return a.playerName.localeCompare(b.playerName);
    });
    sortedAnswers.forEach((ar) => {
      const question = game.questions[ar.questionIndex];
      if (!question) return;
      const qStart = ar.answerTime ? new Date(ar.answerTime - ar.responseTime) : new Date();
      const qDatetime = qStart.toISOString();
      const cDatetime = ar.answerTime ? new Date(ar.answerTime).toISOString() : '';
      const correctIdxs = getCorrectAnswerArray(question);
      const correctSet = new Set(correctIdxs);
      const correctStr = correctIdxs.map((i) => question.options[i] ?? '').join(' | ');
      const wrongs = question.options
        .map((opt, i) => (correctSet.has(i) ? null : opt))
        .filter((v): v is string => v !== null);
      while (wrongs.length < 3) wrongs.push('');
      const choiceIdxs = parseAnswerIndices(ar.answerIndex);
      const choiceStr = choiceIdxs.map((i) => question.options[i] ?? '').join(' | ');
      rows.push([
        ar.questionIndex.toString(),
        qDatetime,
        question.questionType === 'multi' ? 'multi' : 'single',
        question.question.replace(/\t/g, ' '),
        correctStr.replace(/\t/g, ' '),
        wrongs[0].replace(/\t/g, ' '),
        wrongs[1].replace(/\t/g, ' '),
        wrongs[2].replace(/\t/g, ' '),
        (question.explanation || '').replace(/\t/g, ' '),
        ar.playerId,
        ar.playerName.replace(/\t/g, ' '),
        choiceStr.replace(/\t/g, ' '),
        cDatetime,
        ar.hasDyslexiaSupport ? 'true' : 'false',
      ].join('\t'));
    });
    return rows.join('\n');
  }

  toggleDyslexiaSupport(game: Game, playerId: string): boolean {
    const player = this.getPlayerById(playerId, game);
    if (!player || player.isHost) return false;
    player.hasDyslexiaSupport = !player.hasDyslexiaSupport;
    return true;
  }
}
