import { v4 as uuidv4 } from 'uuid';
import { randomInt } from 'crypto';
import type { Game, Question, GameSettings, GamePhase, Player } from '@/types/game';
import { gameConfig } from '@/lib/config';
import { insertGame, updateGameStatus, upsertPlayer } from '@/lib/db';

const MAX_PIN_GENERATION_ATTEMPTS = 1000;

export class GameManager {
  private games: Map<string, Game> = new Map();
  private gamesByPin: Map<string, string> = new Map(); // pin -> gameId
  private socketToGame: Map<string, string> = new Map(); // Phase 7: O(1) disconnect lookup

  /** Phase 7: associate a socket with a game so disconnect doesn't have to iterate all games. */
  attachSocket(socketId: string, gameId: string): void {
    this.socketToGame.set(socketId, gameId);
  }

  /** Phase 7: remove the association. Returns the previously-attached gameId (if any). */
  detachSocket(socketId: string): string | undefined {
    const gameId = this.socketToGame.get(socketId);
    this.socketToGame.delete(socketId);
    return gameId;
  }

  /** Phase 7: O(1) lookup of the Game for a given socket. */
  getGameForSocket(socketId: string): Game | undefined {
    const gameId = this.socketToGame.get(socketId);
    return gameId ? this.games.get(gameId) : undefined;
  }

  createGame(
    hostSocketId: string,
    title: string,
    questions: Question[],
    settings: GameSettings,
    hostUserId: string | null = null
  ): Game {
    const gameId = uuidv4();
    const hostId = uuidv4(); // Generate persistent ID for host
    const pin = this.generatePin();

    const game: Game = {
      id: gameId,
      pin,
      hostId: hostId,
      title,
      questions,
      settings,
      currentQuestionIndex: -1,
      status: 'waiting',
      phase: 'waiting',
      players: [{
        id: hostId,
        socketId: hostSocketId,
        name: 'Host',
        score: 0,
        isHost: true,
        isConnected: true
      }],
      gameLoopActive: false,
      answerHistory: []
    };

    // Phase 5: track activity for idle GC
    game.lastActivityAt = Date.now();

    this.games.set(gameId, game);
    this.gamesByPin.set(pin, gameId);

    // Phase 4: persist
    try {
      insertGame(game, hostUserId);
      upsertPlayer(gameId, game.players[0], hostUserId);
    } catch (e) {
      console.error('[db] insertGame failed:', e);
    }

    return game;
  }

  /**
   * Phase 5: mark game as having activity right now. Used by idle-game GC to
   * decide when to auto-finish abandoned games.
   */
  markActive(gameId: string): void {
    const game = this.games.get(gameId);
    if (game) game.lastActivityAt = Date.now();
  }

  getGame(gameId: string): Game | undefined {
    return this.games.get(gameId);
  }

  getGameByPin(pin: string): Game | undefined {
    const gameId = this.gamesByPin.get(pin);
    return gameId ? this.games.get(gameId) : undefined;
  }

  deleteGame(gameId: string): void {
    const game = this.games.get(gameId);
    if (game) {
      this.gamesByPin.delete(game.pin);
      this.games.delete(gameId);
    }
  }

  updateGameStatus(gameId: string, status: GamePhase): void {
    const game = this.games.get(gameId);
    if (game) {
      game.status = status;
    }
  }

  updateGamePhase(gameId: string, phase: GamePhase): void {
    const game = this.games.get(gameId);
    if (game) {
      game.phase = phase;
      game.status = phase; // Keep status in sync with phase for backwards compatibility
      // Phase 4: persist
      try { updateGameStatus(gameId, phase, game.currentQuestionIndex); } catch (e) { console.error('[db] updateGameStatus failed:', e); }
    }
  }

  updateCurrentQuestion(gameId: string, questionIndex: number): void {
    const game = this.games.get(gameId);
    if (game) {
      game.currentQuestionIndex = questionIndex;
    }
  }

  setQuestionStartTime(gameId: string, startTime: number): void {
    const game = this.games.get(gameId);
    if (game) {
      game.questionStartTime = startTime;
    }
  }

  setPhaseStartTime(gameId: string, startTime: number): void {
    const game = this.games.get(gameId);
    if (game) {
      game.phaseStartTime = startTime;
    }
  }

  getCurrentQuestion(game: Game): Question | undefined {
    return game.questions[game.currentQuestionIndex];
  }

  isGameFinished(game: Game): boolean {
    return game.currentQuestionIndex >= game.questions.length - 1;
  }

  /**
   * Generate a unique PIN using a cryptographically secure RNG.
   * Bounded retry: throws if it cannot find a free PIN after MAX_PIN_GENERATION_ATTEMPTS.
   * Practically only fires when the PIN namespace is near saturation (10^pinLength games).
   */
  private generatePin(): string {
    const pinLength = gameConfig.pinLength;
    const min = Math.pow(10, pinLength - 1);
    const max = Math.pow(10, pinLength); // randomInt upper bound is exclusive
    for (let attempt = 0; attempt < MAX_PIN_GENERATION_ATTEMPTS; attempt++) {
      const pin = randomInt(min, max).toString();
      if (!this.gamesByPin.has(pin)) return pin;
    }
    throw new Error(
      `Could not allocate a free PIN after ${MAX_PIN_GENERATION_ATTEMPTS} attempts. ` +
      `Active games: ${this.gamesByPin.size}. Consider increasing pinLength.`
    );
  }

  // Debug methods
  getAllGames(): Game[] {
    return Array.from(this.games.values());
  }

  getGameCount(): number {
    return this.games.size;
  }
}

/**
 * Phase 3: strip server-only heavy fields before broadcasting a Game to clients.
 *
 * `answerHistory` grows unbounded over a game's lifetime (200 players × 60 questions
 * = 12k records, ~200 bytes each = ~2.4 MB). Multiplying that by every emit to every
 * socket is O(n²) bandwidth. Clients never read it — it's only used server-side for
 * the TSV log export. This helper returns a shallow copy with `answerHistory: []`.
 *
 * `questions` is emptied for the same reason plus a correctness one: every Question
 * carries `correctAnswer`, and this object is broadcast to the whole game room
 * (`io.to(game.id)`), so shipping it let any player read the entire answer key out
 * of the socket payload in devtools before the first question was even asked. The
 * gameplay loop already sends each question separately, per socket, at the moment
 * it is due — see GameplayLoop's getShuffledQuestionForPlayer — so no client ever
 * needed the full list. Only the count was actually used, and that is preserved as
 * `totalQuestions`.
 */
/**
 * Public projection of a Player for broadcast to clients. Drops socketId (an internal
 * routing handle), currentAnswer / answerTime (would leak live answers to other players)
 * and the per-question scoring scratch fields. `isHost` and `hasDyslexiaSupport` stay
 * because the host lobby roster filters on / toggles them.
 */
export function toPublicPlayer(p: Player): Player {
  return {
    id: p.id,
    name: p.name,
    score: p.score,
    isHost: p.isHost,
    isConnected: p.isConnected,
    rank: p.rank,
    hasDyslexiaSupport: p.hasDyslexiaSupport,
  } as Player;
}

export function sanitizeGameForClient(game: Game): Game {
  return {
    ...game,
    answerHistory: [],
    questions: [],
    totalQuestions: game.questions.length,
    // Never ship the raw roster: it carried every player's currentAnswer, answerTime and
    // socketId to every client (validateGame / joinGame callbacks, gameStarted, gameUpdated).
    players: game.players.map(toPublicPlayer),
  };
}
