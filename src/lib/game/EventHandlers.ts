import { Server as SocketIOServer, Socket } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  Question,
  GameSettings,
  Game,
  Player,
  ValidateGameAuth,
} from '@/types/game';
import { GameManager, sanitizeGameForClient, toPublicPlayer } from './GameManager';
import { PlayerManager } from './PlayerManager';
import { QuestionManager } from './QuestionManager';
import { GameplayLoop } from './GameplayLoop';
import { issueHostToken, verifyHostToken, verifyPlayerToken } from './tokens';
import { resolveSocketUserId, setSocketUserId, getSocketUserId } from './socket-auth';
import {
  validateCreateGamePayload,
  validateJoinGamePayload,
  validateSubmitAnswerPayload,
  validateGameId,
  LIMITS,
} from './validators';
import {
  joinGameIpLimiter,
  createGameIpLimiter,
  submitAnswerLimiter,
  validateGameLimiter,
  downloadLogsLimiter,
  hostEventLimiter,
  connectionLimiter,
} from '@/lib/rate-limit';

/**
 * Resolve the real client IP behind Cloudflare Tunnel. CF sets `cf-connecting-ip`
 * on the WebSocket upgrade request; the underlying TCP peer is always loopback
 * (cloudflared on 127.0.0.1) so `socket.handshake.address` is useless in prod.
 * Falls back to handshake.address for dev / direct connections.
 */
function getSocketIp(socket: Socket): string {
  const cfIp = socket.handshake.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.length > 0) return cfIp;
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]!.trim();
  return socket.handshake.address || 'unknown';
}

export class EventHandlers {
  constructor(
    private io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>,
    private gameManager: GameManager,
    private playerManager: PlayerManager,
    private questionManager: QuestionManager,
    private gameplayLoop: GameplayLoop
  ) {}

  setupEventHandlers(): void {
    // Resolve the NextAuth session once per handshake and pin it on socket.data. Skipped
    // on connectionStateRecovery (skipMiddlewares) — socket.data is restored with the socket.
    this.io.use((socket, next) => {
      resolveSocketUserId(socket)
        .then((id) => setSocketUserId(socket, id))
        .catch(() => setSocketUserId(socket, null))
        .finally(() => next());
    });
    this.io.on('connection', (socket) => {
      // Connection-level rate limit: throttle new socket opens per IP. Reject the
      // socket entirely if exceeded — no events get wired up. This is the cheapest
      // backstop against a botnet establishing 1000s of sockets.
      const ip = getSocketIp(socket);
      if (!connectionLimiter.consume(ip)) {
        socket.disconnect(true);
        return;
      }
      // The dbUserId argument clients still send is IGNORED — identity comes from the
      // session cookie (socket.data.dbUserId). The slot stays in the protocol so older
      // tabs keep working across the deploy.
      socket.on('createGame', (title, questions, settings, _dbUserId, callback) => {
        if (!createGameIpLimiter.consume(ip)) {
          socket.emit('error', 'Slow down — too many quizzes created');
          return;
        }
        this.handleCreateGame(socket, title, questions, settings, getSocketUserId(socket), callback);
      });
      socket.on('joinGame', (pin, playerName, persistentId, playerToken, _dbUserId, callback) => {
        // Per-IP cap absorbs the classroom-mass-join burst (capacity 250) while limiting
        // PIN enumeration sustained rate to ~5/sec. Earlier draft of this had a per-(IP, PIN)
        // cap too — dropped because real classrooms share an IP AND a PIN, so it just
        // throttled legitimate students.
        if (!joinGameIpLimiter.consume(ip)) {
          socket.emit('error', 'Too many join attempts — slow down');
          callback?.(false);
          return;
        }
        this.handleJoinGame(socket, pin, playerName, persistentId, playerToken, getSocketUserId(socket), callback);
      });
      socket.on('validateGame', (gameId, auth, callback) => {
        if (!validateGameLimiter.consume(ip)) {
          // Return false rather than emit an error — fewer info leaks to attackers
          // probing whether a gameId is valid, and reconnecting clients fall back
          // naturally.
          callback?.(false);
          return;
        }
        this.handleValidateGame(socket, gameId, auth, callback);
      });
      socket.on('startGame', (gameId, hostToken) => {
        this.handleHostEvent(socket, gameId, hostToken, 'startGame', (game) => {
          socket.join(game.id);
          const playerCount = this.playerManager.getConnectedPlayers(game).length;
          console.log(`[PIN ${game.pin}] Starting game with ${playerCount} active players`);
          this.io.to(game.id).emit('gameStarted', sanitizeGameForClient(game));
          this.gameplayLoop.startGameLoop(game);
        });
      });
      socket.on('submitAnswer', (gameId, questionId, answer, persistentId, playerToken, qEpoch, clientPerceivedMs) => {
        // Keyed per playerId, not IP — one classroom IP has 200 players each
        // submitting one answer per question. The per-player burst (8) handles a
        // mis-click flurry; the refill (~2/s) caps any sustained spam.
        if (typeof persistentId === 'string' && !submitAnswerLimiter.consume(persistentId)) {
          // Silent drop — submitAnswer already silently ignores duplicate answers,
          // so the user sees the same UX (no error event).
          return;
        }
        this.handleSubmitAnswer(socket, gameId, questionId, answer, persistentId, playerToken, qEpoch, clientPerceivedMs);
      });
      socket.on('nextQuestion', (gameId, hostToken) => {
        this.handleHostEvent(socket, gameId, hostToken, 'nextQuestion', (game) => {
          if (game.phase !== 'leaderboard') return;
          this.gameplayLoop.transitionToPhase(game, 'preparation');
        });
      });
      socket.on('showLeaderboard', (gameId, hostToken) => {
        this.handleHostEvent(socket, gameId, hostToken, 'showLeaderboard', (game) => {
          this.gameplayLoop.transitionToPhase(game, 'leaderboard');
        });
      });
      socket.on('endGame', (gameId, hostToken) => {
        this.handleHostEvent(socket, gameId, hostToken, 'endGame', (game) => {
          this.gameplayLoop.transitionToPhase(game, 'finished');
        });
      });
      socket.on('downloadGameLogs', (gameId, hostToken) => {
        if (!downloadLogsLimiter.consume(ip)) {
          socket.emit('error', 'Too many download requests — try again in a moment');
          return;
        }
        this.handleDownloadGameLogs(socket, gameId, hostToken);
      });
      socket.on('kickPlayer', (gameId, playerId, hostToken) => {
        this.handleHostEvent(socket, gameId, hostToken, 'kickPlayer', (game) => {
          if (typeof playerId !== 'string' || playerId.length === 0 || playerId.length > LIMITS.ID_MAX) {
            socket.emit('error', 'Invalid playerId');
            return;
          }
          const target = this.playerManager.getPlayerById(playerId, game);
          if (!target || target.isHost) {
            socket.emit('error', 'Player not found');
            return;
          }
          // Kick the target's socket if currently connected — they receive 'kicked'
          // (same UX as the single-session-lock kick).
          if (target.socketId) {
            const targetSocket = this.io.sockets.sockets.get(target.socketId);
            if (targetSocket) {
              targetSocket.emit('kicked', 'Removed by host');
              this.gameManager.detachSocket(target.socketId);
              targetSocket.disconnect(true);
            }
          }
          const removed = this.playerManager.removePlayer(playerId, game);
          if (removed) {
            console.log(`[PIN ${game.pin}] Host kicked player ${target.name}`);
            this.io.to(game.id).emit('playerLeft', playerId);
          }
        });
      });
      socket.on('skipQuestion', (gameId, hostToken) => {
        this.handleHostEvent(socket, gameId, hostToken, 'skipQuestion', (game) => {
          // Only meaningful during thinking or answering — moving to results from any
          // other phase would either no-op (already past) or scramble the state machine.
          if (game.phase !== 'thinking' && game.phase !== 'answering') {
            return;
          }
          this.gameplayLoop.transitionToPhase(game, 'results');
        });
      });
      socket.on('restartQuestion', (gameId, hostToken) => {
        this.handleHostEvent(socket, gameId, hostToken, 'restartQuestion', (game) => {
          // Limit to thinking/answering — by results phase, points are already in
          // player.score / scoredQuestions / DB, so a clean undo gets complicated.
          if (game.phase !== 'thinking' && game.phase !== 'answering') {
            return;
          }
          this.playerManager.clearAnswers(game);
          this.gameplayLoop.transitionToPhase(game, 'thinking');
        });
      });
      socket.on('toggleDyslexiaSupport', (gameId, playerId, hostToken) => {
        this.handleHostEvent(socket, gameId, hostToken, 'toggleDyslexiaSupport', (game) => {
          if (typeof playerId !== 'string' || playerId.length === 0 || playerId.length > LIMITS.ID_MAX) {
            socket.emit('error', 'Invalid playerId');
            return;
          }
          if (game.status !== 'waiting') {
            socket.emit('error', 'Can only toggle dyslexia support in lobby');
            return;
          }
          const ok = this.playerManager.toggleDyslexiaSupport(game, playerId);
          if (ok) {
            const player = this.playerManager.getPlayerById(playerId, game);
            console.log(`[PIN ${game.pin}] Toggled dyslexia for ${player?.name || playerId} → ${player?.hasDyslexiaSupport ? 'on' : 'off'}`);
            this.io.to(game.id).emit('gameUpdated', sanitizeGameForClient(game));
          } else {
            socket.emit('error', 'Failed to toggle dyslexia support');
          }
        });
      });
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  // ===== Helpers =====

  /**
   * Common wrapper for host-authenticated events.
   * Validates gameId + hostToken + game existence + host identity, then runs `action`.
   */
  private handleHostEvent(
    socket: Socket,
    gameId: string,
    hostToken: unknown,
    eventName: string,
    action: (game: Game) => void
  ): void {
    if (validateGameId(gameId)) return;
    const game = this.gameManager.getGame(gameId);
    if (!game) {
      socket.emit('error', 'Game not found');
      return;
    }
    if (!verifyHostToken(hostToken, game.id, game.hostId)) {
      const tokStr = typeof hostToken === 'string' ? hostToken : `[${typeof hostToken}]`;
      const tokLen = typeof hostToken === 'string' ? hostToken.length : 0;
      const tokPrefix = typeof hostToken === 'string' ? hostToken.slice(0, 12) : tokStr;
      console.warn(
        `[${eventName}] Rejected from ${socket.id} | PIN ${game.pin} | gameId=${game.id.slice(0, 8)}... | hostId=${game.hostId.slice(0, 8)}... | token type=${typeof hostToken} len=${tokLen} prefix='${tokPrefix}'`
      );
      socket.emit('error', 'Not authorized');
      return;
    }
    // Per-host rate limit applied AFTER token verify so attackers spamming bogus
    // tokens hit the 'Not authorized' path (cheap) without exhausting the host's
    // own bucket. 30/s sustained is way above any real host UI debouncing.
    if (!hostEventLimiter.consume(game.hostId)) {
      // Drop silently — host UI debounces, this is a backstop against scripted abuse.
      return;
    }
    try {
      this.gameManager.markActive(game.id); // Phase 5: idle GC — any host action keeps the game alive
      action(game);
    } catch (error) {
      console.error(`[${eventName}] Error:`, error);
      socket.emit('error', `Failed: ${eventName}`);
    }
  }

  // ===== downloadGameLogs =====
  // Live or recently-finished games only. Once the in-memory game is gone (60s after
  // finished), use the authenticated HTTP route at /api/games/[id]/tsv — it does a
  // SQL ownership check that this socket path can't (no NextAuth session attached).

  private handleDownloadGameLogs(socket: Socket, gameId: string, hostToken: unknown): void {
    if (validateGameId(gameId)) {
      socket.emit('error', 'Invalid gameId');
      return;
    }
    try {
      const game = this.gameManager.getGame(gameId);
      if (!game) {
        socket.emit('error', 'Game not found or expired — use /host/history');
        return;
      }
      if (!verifyHostToken(hostToken, game.id, game.hostId)) {
        socket.emit('error', 'Not authorized');
        return;
      }
      const tsvData = this.playerManager.generateGameLogsTSV(game);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      socket.emit('gameLogs', tsvData, `game_${game.pin}_${timestamp}.tsv`);
    } catch (error) {
      console.error('[DOWNLOAD_LOGS] Error:', error);
      socket.emit('error', 'Failed to download logs');
    }
  }

  // ===== createGame =====

  private handleCreateGame(
    socket: Socket,
    title: string,
    questions: Question[],
    settings: GameSettings,
    dbUserId: string | null,
    callback: (game: Game, hostToken: string) => void
  ): void {
    const err = validateCreateGamePayload(title, questions, settings);
    if (err) {
      console.warn(`[CREATE_GAME] Rejected from ${socket.id}: ${err}`);
      socket.emit('error', err);
      return;
    }
    try {
      const game = this.gameManager.createGame(socket.id, title, questions, settings, dbUserId);
      const hostToken = issueHostToken(game.id, game.hostId);
      socket.join(game.id);
      this.gameManager.attachSocket(socket.id, game.id); // Phase 7
      callback(sanitizeGameForClient(game), hostToken);
    } catch (error) {
      console.error('[CREATE_GAME] Error:', error);
      socket.emit('error', 'Failed to create game');
    }
  }

  // ===== joinGame =====

  private handleJoinGame(
    socket: Socket,
    pin: string,
    playerName: string,
    persistentId: string | null,
    playerToken: string | null,
    dbUserId: string | null,
    callback: (success: boolean, game?: Game, playerId?: string, playerToken?: string) => void
  ): void {
    const err = validateJoinGamePayload(pin, playerName, persistentId);
    if (err) {
      console.warn(`[JOIN_GAME] Rejected from ${socket.id}: ${err}`);
      callback?.(false);
      return;
    }
    try {
      const game = this.gameManager.getGameByPin(pin);
      if (!game) {
        callback?.(false);
        return;
      }
      const result = this.playerManager.joinGame(game, socket.id, playerName, persistentId, playerToken, dbUserId);
      if (result.success && result.game) {
        socket.join(result.game.id);
        this.gameManager.attachSocket(socket.id, result.game.id); // Phase 7
        this.gameManager.markActive(result.game.id); // Phase 5: idle GC

        // Phase 7: single-active-session lock — kick the old socket if same player connected from elsewhere
        if (result.kickedSocketId && result.kickedSocketId !== socket.id) {
          const oldSocket = this.io.sockets.sockets.get(result.kickedSocketId);
          if (oldSocket) {
            oldSocket.emit('kicked', 'You were signed in from another device.');
            // Detach + disconnect (will not trigger host-grace because non-host path)
            this.gameManager.detachSocket(result.kickedSocketId);
            oldSocket.disconnect(true);
            console.log(`[PIN ${result.game.pin}] Kicked old socket ${result.kickedSocketId.slice(0, 8)} for player ${result.playerId?.slice(0, 8)}`);
          }
        }

        const connectedPlayers = this.playerManager.getConnectedPlayers(result.game).length;
        console.log(`[PIN ${result.game.pin}] Player ${result.isReconnection ? 'reconnected' : 'joined'} | Connected: ${connectedPlayers}`);
        const player = this.playerManager.getPlayerById(result.playerId!, result.game);
        const publicPlayer = toPublicPlayer(player!);
        if (result.isReconnection) {
          this.io.to(result.game.id).emit('playerReconnected', publicPlayer);
        } else {
          this.io.to(result.game.id).emit('playerJoined', publicPlayer);
        }
      } else if (result.reason) {
        console.warn(`[JOIN_GAME] ${socket.id}: ${result.reason}`);
      }
      callback?.(
        result.success,
        result.game ? sanitizeGameForClient(result.game) : undefined,
        result.playerId,
        result.playerToken
      );
    } catch (error) {
      console.error('[JOIN_GAME] Error:', error);
      callback?.(false);
    }
  }

  // ===== validateGame (reconnection / late join) =====

  private handleValidateGame(
    socket: Socket,
    gameId: string,
    auth: ValidateGameAuth,
    callback: (valid: boolean, game?: Game) => void
  ): void {
    if (validateGameId(gameId)) {
      callback(false);
      return;
    }
    try {
      const game = this.gameManager.getGame(gameId);
      if (!game) {
        callback(false);
        return;
      }

      // Determine identity from auth — server cannot trust the socket alone.
      let isHost = false;
      let isKnownPlayer = false;
      let reconnectedPlayer: Player | undefined;

      if (auth && typeof auth === 'object') {
        if (auth.hostToken && verifyHostToken(auth.hostToken, game.id, game.hostId)) {
          isHost = true;
        } else if (
          auth.playerId &&
          auth.playerToken &&
          verifyPlayerToken(auth.playerToken, game.id, auth.playerId)
        ) {
          const player = this.playerManager.getPlayerById(auth.playerId, game);
          if (player && !player.isHost) {
            isKnownPlayer = true;
            reconnectedPlayer = player;
          }
        }
      }

      // For non-host visitors, host must be present (avoid lingering ghost games)
      const host = this.playerManager.getHost(game);
      const hasActiveHost = host?.isConnected ?? false;
      if (!isHost && !hasActiveHost) {
        callback(false);
        return;
      }

      // Join the room BEFORE swapping identities: clearHostDisconnectGrace -> resume emits
      // to the room and to player sockets, and both must reach this socket.
      socket.join(game.id);
      this.gameManager.attachSocket(socket.id, game.id); // Phase 7

      if (isHost && host) {
        // Host (re)connect: swap socketId, mark connected, clear any grace timer (resumes a
        // paused phase). The old socket, if still around, is detached so its eventual
        // 'disconnect' cannot mark the host offline again.
        if (host.socketId && host.socketId !== socket.id) this.gameManager.detachSocket(host.socketId);
        host.socketId = socket.id;
        host.isConnected = true;
        this.gameplayLoop.clearHostDisconnectGrace(game.id);
      } else if (reconnectedPlayer) {
        const wasOffline = !reconnectedPlayer.isConnected || reconnectedPlayer.socketId !== socket.id;
        if (reconnectedPlayer.socketId && reconnectedPlayer.socketId !== socket.id) {
          this.gameManager.detachSocket(reconnectedPlayer.socketId);
        }
        reconnectedPlayer.socketId = socket.id;
        reconnectedPlayer.isConnected = true;
        // Only the host roster cares; don't wake 200 phones for one reconnect.
        if (wasOffline && host?.isConnected) {
          this.io.to(host.socketId).emit('playerReconnected', toPublicPlayer(reconnectedPlayer));
        }
      }

      if (game.gameLoopActive) {
        this.gameplayLoop.syncPlayerToCurrentPhase(game, socket.id, isHost, isKnownPlayer);
      }
      this.gameManager.markActive(game.id);
      callback(true, sanitizeGameForClient(game));
    } catch (error) {
      console.error('[VALIDATE_GAME] Error:', error);
      callback(false);
    }
  }

  // ===== submitAnswer =====

  private handleSubmitAnswer(
    socket: Socket,
    gameId: string,
    questionId: string,
    answer: number | number[],
    persistentId: string,
    playerToken: string,
    qEpoch: unknown,
    clientPerceivedMs?: number
  ): void {
    const err = validateSubmitAnswerPayload(gameId, questionId, answer, persistentId);
    if (err) {
      console.warn(`[SUBMIT_ANSWER] Rejected from ${socket.id}: ${err}`);
      return;
    }
    try {
      const game = this.gameManager.getGame(gameId);
      if (!game) return;
      if (!persistentId || !verifyPlayerToken(playerToken, game.id, persistentId)) {
        console.warn(`[SUBMIT_ANSWER] Rejected from ${socket.id}: invalid playerToken (PIN ${game.pin})`);
        return;
      }
      const player = this.playerManager.getPlayerById(persistentId, game);
      if (!player || player.isHost) return;

      const reject = (code: string, message: string) => {
        console.warn(`[SUBMIT_ANSWER] Rejected ${player.name} (${code}) PIN ${game.pin} phase=${game.phase} qEpoch=${String(qEpoch)}/${game.qEpoch}`);
        socket.emit('answerRejected', message);
      };

      // qEpoch is REQUIRED: it is the only thing tying the answer to the phase the client
      // actually saw. A stale epoch means a previous question, a pre-pause phase, or a
      // client that never received answeringPhase.
      if (typeof qEpoch !== 'number' || !Number.isFinite(qEpoch)) {
        reject('missing_epoch', 'Your answer could not be matched to the current question.');
        return;
      }
      if (qEpoch !== (game.qEpoch ?? 0)) {
        reject('stale_epoch', 'That question has moved on — your answer was not counted.');
        return;
      }
      // Paused for host disconnect: resume shifts questionStartTime forward, so an answer
      // accepted now would be scored as if it took ~0 ms (full 1000 points).
      if (game.pausedPhase) {
        reject('paused', 'The game is paused while the host reconnects. Answer again when the timer restarts.');
        return;
      }
      // Already scored (results phase entered early because everyone connected answered, or
      // the final safety-net scoring ran). A late answer here would be stored as 0 points
      // with wasCorrect=true — wrong on both counts.
      if (game.scoredQuestions?.includes(game.currentQuestionIndex)) {
        reject('already_scored', 'Too late — this question has already been scored.');
        return;
      }

      // Phase 6: late-answer grace — accept submissions up to deadline + grace even after server transitioned phase
      const now = Date.now();
      const withinAnswering = game.phase === 'answering';
      const withinGrace =
        game.phase === 'results' &&
        game.answerDeadlineMs !== undefined &&
        now <= game.answerDeadlineMs;
      if (!withinAnswering && !withinGrace) {
        reject('closed', 'Answering is closed for this question.');
        return;
      }

      const success = this.playerManager.submitAnswer(
        game,
        persistentId,
        answer,
        true,
        typeof clientPerceivedMs === 'number' && Number.isFinite(clientPerceivedMs) && clientPerceivedMs >= 0
          ? Math.min(clientPerceivedMs, game.settings.answerTime * 1000)
          : undefined
      );
      if (success) {
        this.gameManager.markActive(game.id); // Phase 5: idle GC
        this.gameplayLoop.onPlayerAnswered(game);
      }
    } catch (error) {
      console.error('[SUBMIT_ANSWER] Error:', error);
    }
  }

  // ===== disconnect =====

  private handleDisconnect(socket: Socket): void {
    try {
      // Phase 7: O(1) lookup via socketToGame index instead of iterating all games
      const game = this.gameManager.getGameForSocket(socket.id);
      this.gameManager.detachSocket(socket.id);
      if (!game) return;
      const player = this.playerManager.getPlayerBySocketId(socket.id, game);
      if (player) {
        this.playerManager.disconnectPlayer(socket.id, game);
        this.io.to(game.id).emit('playerDisconnected', player.id);
        if (player.isHost) {
          // Phase 2: don't kill the classroom on a wifi blip — start the grace timer
          this.gameplayLoop.startHostDisconnectGrace(game);
        }
      }
    } catch (error) {
      console.error('[DISCONNECT] Error:', error);
    }
  }
}
