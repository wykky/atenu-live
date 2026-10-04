/**
 * Question types:
 * - 'single' (default): exactly one correct answer. Tapping a button auto-submits.
 * - 'multi':  two or three correct answers. Player toggles selections and taps Submit.
 *
 * For backward compat `correctAnswer` is always populated (single = the answer, multi =
 * correctAnswers[0]). Read multi-aware code via helpers in src/lib/game/questionType.ts.
 */
export type QuestionType = 'single' | 'multi';

export interface Question {
  id: string;
  question: string;
  options: string[];
  correctAnswer: number; // Index of (primary) correct answer (0-3)
  // Multi-select questions only: full set of correct indices (2-3 entries).
  // For single-correct questions this is undefined; canonical answer is `correctAnswer`.
  correctAnswers?: number[];
  questionType?: QuestionType; // Undefined defaults to 'single'
  timeLimit: number; // Time limit in seconds
  explanation?: string;
  image?: string;
}

export interface AnswerRecord {
  playerId: string;
  playerName: string;
  questionIndex: number;
  questionId: string;
  // Single-select: the chosen index (0-3) or null. Multi-select: comma-joined indices
  // (e.g. "0,2") for stable TSV export, or null if no selection was made.
  answerIndex: number | string | null;
  answerTime?: number;
  responseTime: number; // milliseconds from question start
  pointsEarned: number;
  wasCorrect: boolean;
  hasDyslexiaSupport: boolean; // New field for dyslexia support tracking
}

export interface GameSettings {
  thinkTime: number; // Time to show question before allowing answers (in seconds)
  answerTime: number; // Time allowed to answer (in seconds)
  showQuestionOnPlayers?: boolean; // If true, players see question + answers on their phones
  // When true, each player sees A/B/C/D options in their own random order. Server stores
  // a per-(player, question) permutation and translates submitted indices back to canonical.
  // Anti-peek defense in classroom settings where students sit next to each other.
  shuffleAnswers?: boolean;
}

export type GamePhase = 'waiting' | 'preparation' | 'thinking' | 'answering' | 'results' | 'leaderboard' | 'finished';

export interface Game {
  id: string;
  pin: string;
  hostId: string;
  title: string;
  questions: Question[];
  // Number of questions in the quiz. Populated by sanitizeGameForClient, which
  // empties `questions` before broadcasting so players can't read the answer key
  // out of the socket payload. Client code must use this instead of
  // `questions.length`, which is 0 on every client.
  totalQuestions?: number;
  settings: GameSettings;
  currentQuestionIndex: number;
  status: GamePhase;
  phase: GamePhase; // Current gameplay phase
  players: Player[];
  questionStartTime?: number;
  phaseStartTime?: number;
  phaseEndTime?: number;
  gameLoopActive?: boolean; // Whether the gameplay loop is running
  answerHistory: AnswerRecord[]; // Historical record of all answers
  lastActivityAt?: number; // Updated on any meaningful event — used by idle-game GC
  qEpoch?: number; // Phase 6: bumps on each thinking/answering phase entry; used to reject stale answers
  answerDeadlineMs?: number; // Phase 6: server-side deadline incl. grace; for late-answer acceptance
  // Question indices already passed through PlayerManager.updateScores. Makes updateScores
  // idempotent so we can call it defensively from executeFinishedPhase without double-credit.
  scoredQuestions?: number[];
  // Pause state when host disconnects mid-thinking / mid-answering. Captured on disconnect,
  // consumed on reconnect: the phase timer is restarted with `pauseRemainingMs` left and
  // qEpoch bumps to invalidate any answers submitted during the gap.
  pauseRemainingMs?: number;
  pausedPhase?: 'thinking' | 'answering';
}

export interface Player {
  id: string; // This is now the persistent player ID (UUID)
  socketId: string; // Current socket connection ID
  name: string;
  score: number;
  isHost: boolean;
  // Single-select: chosen index (0-3). Multi-select: array of selected indices.
  currentAnswer?: number | number[];
  answerTime?: number;
  perceivedResponseMs?: number; // Phase 8: client-reported time-to-click, used for adaptive scoring
  isConnected: boolean; // Track connection status
  hasDyslexiaSupport?: boolean; // New field for dyslexia support
  // Cached per-question points (includes streak bonus). Set once by PlayerManager.updateScores;
  // read by storeAnswersToHistory (TSV row) and getPersonalResult (player's "+X" toast).
  // Cleared in clearAnswers between questions.
  lastPointsEarned?: number;
  // Phase 8+ tie-aware competition rank (1,1,3,4,5,5,7). Set server-side before
  // leaderboardShown / gameFinished emits. Clients should prefer this over array index.
  rank?: number;
  // Consecutive correct answers. Increments on correct, resets to 0 on wrong / no answer.
  // Persists across host restartQuestion since clearAnswers doesn't reset it.
  currentStreak?: number;
  // Bonus points earned from the streak on the last scored question (0 on streak 0 or 1).
  streakBonus?: number;
  // +100 bonus when this player was the earliest correct submitter on the last scored question.
  firstCorrectBonus?: number;
}

export interface GameStats {
  question: Question;
  answers: {
    optionIndex: number;
    count: number;
    percentage: number;
  }[];
  correctAnswers: number;
  totalPlayers: number;
}

export interface PersonalResult {
  wasCorrect: boolean;
  pointsEarned: number;
  totalScore: number;
  position: number;
  pointsBehind: number;
  nextPlayerName: string | null;
  explanation?: string;
  // Kahoot-style consecutive-correct streak + bonus points from this question
  currentStreak?: number;
  streakBonus?: number;
  // +100 if this player was the earliest correct submitter on this question
  firstCorrectBonus?: number;
  // The answer key, in THIS player's option order (shuffleAnswers), revealed only now.
  // The thinkingPhase copy players receive has correctAnswer stripped (-1).
  correctAnswer?: number;
  correctAnswers?: number[];
}

/**
 * Phase 6: server-authoritative deadline protocol.
 * Server sends absolute deadline + its own clock so clients can compute skew
 * and render accurate countdowns regardless of network latency.
 */
export interface PhaseDeadline {
  serverNow: number;      // server's Date.now() at emit time
  deadlineMs: number;     // server's absolute deadline timestamp
  qEpoch: number;         // monotonically increasing per phase entry; used to reject stale answers
  // 0-based index of the question this phase belongs to. Required, so the compiler
  // catches any emit site that forgets it. Clients CANNOT use game.currentQuestionIndex
  // for this: the Game object is only re-broadcast on gameStarted / leaderboardShown,
  // so during play it lags one question behind (and reads -1 on the very first).
  questionIndex: number;
}

// Socket Events
export interface ServerToClientEvents {
  gameJoined: (game: Game) => void;
  gameStarted: (game: Game) => void;
  questionStarted: (question: Question, timeLimit: number) => void;
  thinkingPhase: (question: Question, thinkTime: number, deadline?: PhaseDeadline) => void;
  answeringPhase: (answerTime: number, deadline?: PhaseDeadline) => void;
  // Bare "answering is over" signal for players. The full GameStats (which include the
  // answer key) go to the host only via hostResults; each player gets personalResult.
  questionEnded: () => void;
  hostResults: (stats: GameStats) => void;
  personalResult: (result: PersonalResult) => void;
  leaderboardShown: (leaderboard: Player[], game: Game) => void;
  gameFinished: (finalScores: Player[]) => void;
  playerJoined: (player: Player) => void;
  playerReconnected: (player: Player) => void;
  playerLeft: (playerId: string) => void;
  playerDisconnected: (playerId: string) => void;
  error: (message: string) => void;
  // Host socket only, throttled (<= 4/s): how many connected players have answered.
  playerAnswered: (answeredCount: number, totalPlayers: number) => void;
  gameLogs: (tsvData: string, filename: string) => void;
  gameUpdated: (game: Game) => void;
  // Phase 2: emitted to late joiners during a live question (they shouldn't see the question)
  waitForNextQuestion: () => void;
  // Phase 2: emitted to all clients when the host disconnects (grace window started)
  hostReconnecting: (graceMs: number) => void;
  hostReconnected: () => void;
  // Phase 7: emitted to a socket that's being kicked because the same playerId connected from elsewhere
  kicked: (reason: string) => void;
  // Ack to the submitting socket when its submitAnswer was refused (paused, stale, too late...).
  // Lets the phone un-grey its buttons and show a short message instead of silently losing the tap.
  answerRejected: (reason: string) => void;
}

// Auth for validateGame — caller may identify as host (with hostToken) or returning player (with playerId + playerToken).
export interface ValidateGameAuth {
  hostToken?: string;
  playerId?: string;
  playerToken?: string;
}

export interface ClientToServerEvents {
  createGame: (
    title: string,
    questions: Question[],
    settings: GameSettings,
    dbUserId: string | null,
    callback: (game: Game, hostToken: string) => void
  ) => void;
  joinGame: (
    pin: string,
    playerName: string,
    persistentId: string | null,
    playerToken: string | null,
    dbUserId: string | null,
    callback: (success: boolean, game?: Game, playerId?: string, playerToken?: string) => void
  ) => void;
  validateGame: (
    gameId: string,
    auth: ValidateGameAuth,
    callback: (valid: boolean, game?: Game) => void
  ) => void;
  startGame: (gameId: string, hostToken: string) => void;
  submitAnswer: (
    gameId: string,
    questionId: string,
    // Single-select: a single index (0-3). Multi-select: array of indices.
    answer: number | number[],
    persistentId: string,
    playerToken: string,
    // Required: the qEpoch from the answeringPhase deadline the client is answering under.
    qEpoch: number,
    clientPerceivedMs?: number
  ) => void;
  nextQuestion: (gameId: string, hostToken: string) => void;
  showLeaderboard: (gameId: string, hostToken: string) => void;
  endGame: (gameId: string, hostToken: string) => void;
  downloadGameLogs: (gameId: string, hostToken: string) => void;
  toggleDyslexiaSupport: (gameId: string, playerId: string, hostToken: string) => void;
  kickPlayer: (gameId: string, playerId: string, hostToken: string) => void;
  skipQuestion: (gameId: string, hostToken: string) => void;
  restartQuestion: (gameId: string, hostToken: string) => void;
}
