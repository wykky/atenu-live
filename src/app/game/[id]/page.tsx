'use client';

import { useEffect, useReducer, useRef } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { getSocket } from '@/lib/socket-client';
import { getPlayerCreds } from '@/lib/player-storage';
import type { Game, Question, GameStats, Player, PersonalResult, GamePhase, PhaseDeadline, PlayerStanding } from '@/types/game';
// Game Screen Components
import GameValidationScreen from '@/components/game-screens/GameValidationScreen';
import GameErrorScreen from '@/components/game-screens/GameErrorScreen';
import GameWaitingScreen from '@/components/game-screens/GameWaitingScreen';
import GameLeaderboardScreen from '@/components/game-screens/GameLeaderboardScreen';
import GameFinalResultsScreen from '@/components/game-screens/GameFinalResultsScreen';
import GameThinkingPhaseScreen from '@/components/game-screens/GameThinkingPhaseScreen';
import GameWaitingForResultsScreen from '@/components/game-screens/GameWaitingForResultsScreen';
import GameAnsweringPhaseScreen from '@/components/game-screens/GameAnsweringPhaseScreen';
import GameResultsPhaseScreen from '@/components/game-screens/GameResultsPhaseScreen';
import GameFallbackScreen from '@/components/game-screens/GameFallbackScreen';
import PlayerLeaderboardScreen from '@/components/game-screens/PlayerLeaderboardScreen';
import { SkipForward, RotateCcw } from 'lucide-react';

/**
 * Small overlay buttons rendered on the host's thinking/answering screens.
 * Skip jumps to results; Restart re-runs the same question from thinking
 * (clears all answers, bumps qEpoch). Both are stacked bottom-right.
 */
function HostPhaseControls({ onSkip, onRestart }: { onSkip: () => void; onRestart: () => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      <button
        onClick={() => { if (confirm('Restart this question? All current answers will be cleared.')) onRestart(); }}
        aria-label="Restart question"
        title="Restart this question"
        className="px-4 py-2 bg-black/80 text-white text-sm rounded-lg shadow-lg hover:bg-black backdrop-blur-sm flex items-center gap-2"
      >
        <RotateCcw className="w-4 h-4" />
        Restart
      </button>
      <button
        onClick={onSkip}
        aria-label="Skip question"
        title="Skip to results"
        className="px-4 py-2 bg-black/80 text-white text-sm rounded-lg shadow-lg hover:bg-black backdrop-blur-sm flex items-center gap-2"
      >
        <SkipForward className="w-4 h-4" />
        Skip
      </button>
    </div>
  );
}

const HOST_TOKEN_KEY = (gameId: string) => `host_token_${gameId}`;

interface GameState {
  game: Game | null;
  currentQuestion: Question | null;
  timeLeft: number;
  // Phase deadline translated to THIS device's clock (server deadlineMs + measured offset).
  // One interval recomputes timeLeft from it; see the timer effect in GamePage.
  deadlineAt: number | null;
  phase: 'thinking' | 'answering';
  // Multi-select: array of indices the player picked. Single-select: single index. null before answering.
  selectedAnswer: number | number[] | null;
  hasAnswered: boolean;
  questionStats: GameStats | null;
  personalResult: PersonalResult | null;
  finalScores: Player[];
  leaderboard: Player[];
  gameStatus: GamePhase | 'waiting-results';
  gameError: string | null;
  isValidating: boolean;
  hostReconnecting: boolean;
  qEpoch: number | null; // Phase 6: stale-answer guard
  // Short transient message for the player (e.g. why an answer was refused). Auto-cleared.
  notice: string | null;
  // Host only: "N of M connected players have answered" for the current question.
  answeredCount: { answered: number; total: number } | null;
  // Player only: own rank/score on the mid-game leaderboard (players get top-N + this).
  myStanding: PlayerStanding | null;
  // 0-based index of the question currently in play, taken from the phase deadline.
  // Do NOT read game.currentQuestionIndex for this: the Game object is only
  // re-broadcast on gameStarted / leaderboardShown, so during play it lags a
  // question behind (and is -1 during the very first question).
  questionIndex: number | null;
}

type GameAction =
  | { type: 'SET_VALIDATING'; payload: boolean }
  | { type: 'SET_GAME_ERROR'; payload: string }
  | { type: 'SET_GAME_DATA'; payload: { game: Game; status: GamePhase } }
  | { type: 'START_THINKING_PHASE'; payload: { question: Question; thinkTime: number; deadline?: PhaseDeadline } }
  | { type: 'START_ANSWERING_PHASE'; payload: { answerTime: number; deadline?: PhaseDeadline } }
  | { type: 'SUBMIT_ANSWER'; payload: { answer: number | number[] } }
  | { type: 'QUESTION_ENDED'; payload: GameStats }
  | { type: 'WAITING_FOR_RESULTS' }
  | { type: 'PERSONAL_RESULT'; payload: PersonalResult }
  | { type: 'SHOW_LEADERBOARD'; payload: { leaderboard: Player[]; game: Game } }
  | { type: 'GAME_FINISHED'; payload: Player[] }
  | { type: 'SET_TIME_LEFT'; payload: number }
  | { type: 'GAME_STARTED'; payload: Game }
  | { type: 'RECONNECT_SYNC'; payload: Game }
  | { type: 'ANSWER_REJECTED'; payload: string }
  | { type: 'ANSWERED_COUNT'; payload: { answered: number; total: number } }
  | { type: 'MY_STANDING'; payload: PlayerStanding }
  | { type: 'CLEAR_NOTICE' }
  | { type: 'HOST_RECONNECTING'; payload: boolean };

function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'SET_VALIDATING':
      return { ...state, isValidating: action.payload };
    case 'SET_GAME_ERROR':
      return { ...state, gameError: action.payload, isValidating: false };
    case 'SET_GAME_DATA':
      return { ...state, game: action.payload.game, gameStatus: action.payload.status, isValidating: false };
    case 'GAME_STARTED':
      return { ...state, game: action.payload, gameStatus: 'preparation' };
    case 'RECONNECT_SYNC': {
      // After a socket reconnect the server re-sends the phase events (thinkingPhase /
      // answeringPhase / leaderboardShown / gameFinished) that drive the UI, so only
      // refresh the Game object here. 'results' has no sync event: fall back to the
      // waiting-for-results screen unless this player already has their result.
      const g = action.payload;
      const gameStatus =
        g.status === 'results' && !state.personalResult && !state.questionStats
          ? 'waiting-results'
          : g.status === 'waiting'
            ? 'waiting'
            : state.gameStatus;
      return { ...state, game: g, gameStatus, hostReconnecting: false };
    }
    case 'START_THINKING_PHASE': {
      const { deadlineAt, timeLeft } = localDeadline(action.payload.deadline, action.payload.thinkTime);
      return {
        ...state,
        currentQuestion: action.payload.question,
        deadlineAt,
        timeLeft,
        phase: 'thinking',
        selectedAnswer: null,
        hasAnswered: false,
        questionStats: null,
        personalResult: null,
        answeredCount: null,
        gameStatus: 'thinking',
        qEpoch: action.payload.deadline?.qEpoch ?? state.qEpoch,
        questionIndex: action.payload.deadline?.questionIndex ?? state.questionIndex,
      };
    }
    case 'START_ANSWERING_PHASE': {
      const { deadlineAt, timeLeft } = localDeadline(action.payload.deadline, action.payload.answerTime);
      return {
        ...state,
        deadlineAt,
        timeLeft,
        phase: 'answering',
        gameStatus: 'answering',
        qEpoch: action.payload.deadline?.qEpoch ?? state.qEpoch,
        questionIndex: action.payload.deadline?.questionIndex ?? state.questionIndex,
      };
    }
    case 'SUBMIT_ANSWER':
      return { ...state, selectedAnswer: action.payload.answer, hasAnswered: true };
    case 'QUESTION_ENDED':
      return { ...state, questionStats: action.payload, gameStatus: 'results' };
    case 'WAITING_FOR_RESULTS':
      return { ...state, gameStatus: 'waiting-results' };
    case 'PERSONAL_RESULT': {
      // The player's thinkingPhase copy had the answer key stripped; merge the revealed
      // key (already in this player's option order) so the results screen can highlight it.
      const r = action.payload;
      const currentQuestion = state.currentQuestion && typeof r.correctAnswer === 'number'
        ? { ...state.currentQuestion, correctAnswer: r.correctAnswer, correctAnswers: r.correctAnswers }
        : state.currentQuestion;
      return { ...state, personalResult: r, currentQuestion, gameStatus: 'results' };
    }
    case 'SHOW_LEADERBOARD':
      return {
        ...state,
        leaderboard: action.payload.leaderboard,
        game: action.payload.game,
        gameStatus: 'leaderboard',
      };
    case 'GAME_FINISHED':
      return { ...state, finalScores: action.payload, gameStatus: 'finished' };
    case 'SET_TIME_LEFT':
      return state.timeLeft === action.payload ? state : { ...state, timeLeft: action.payload };
    case 'HOST_RECONNECTING':
      return { ...state, hostReconnecting: action.payload };
    case 'ANSWER_REJECTED':
      // Un-grey the buttons: if the phase is still (or becomes) open the player can retry.
      return { ...state, notice: action.payload, hasAnswered: false, selectedAnswer: null };
    case 'ANSWERED_COUNT':
      return { ...state, answeredCount: action.payload };
    case 'MY_STANDING':
      return { ...state, myStanding: action.payload };
    case 'CLEAR_NOTICE':
      return state.notice === null ? state : { ...state, notice: null };
    default:
      return state;
  }
}

/**
 * Clock offset between this device and the server, measured as the MINIMUM of
 * (Date.now() - serverNow) over every PhaseDeadline received. Each sample is
 * offset + one-way latency, so the minimum is the tightest estimate: a slow 3G
 * packet inflates a single sample but never lowers the floor. Module-level so it
 * survives re-renders and reconnects within the tab.
 */
let clockOffsetMs: number | null = null;

function localDeadline(deadline: PhaseDeadline | undefined, fallbackSeconds: number): { deadlineAt: number; timeLeft: number } {
  const now = Date.now();
  if (!deadline) {
    return { deadlineAt: now + fallbackSeconds * 1000, timeLeft: fallbackSeconds };
  }
  const sample = now - deadline.serverNow;
  clockOffsetMs = clockOffsetMs === null ? sample : Math.min(clockOffsetMs, sample);
  const deadlineAt = deadline.deadlineMs + clockOffsetMs;
  return { deadlineAt, timeLeft: Math.max(0, Math.ceil((deadlineAt - now) / 1000)) };
}

const initialState: GameState = {
  game: null,
  currentQuestion: null,
  timeLeft: 0,
  deadlineAt: null,
  phase: 'thinking',
  selectedAnswer: null,
  hasAnswered: false,
  questionStats: null,
  personalResult: null,
  finalScores: [],
  leaderboard: [],
  gameStatus: 'waiting',
  gameError: null,
  isValidating: true,
  hostReconnecting: false,
  qEpoch: null,
  notice: null,
  answeredCount: null,
  myStanding: null,
  questionIndex: null,
};

export default function GamePage() {
  const params = useParams<{ id?: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const gameId = params?.id ?? null;
  const isHost = searchParams?.get('host') === 'true';
  const isPlayer = searchParams?.get('player') === 'true';

  const [state, dispatch] = useReducer(gameReducer, initialState);
  // Phase 8: client-side timestamp of when the current answering phase started (locally).
  // Used to report perceived time on submit for adaptive scoring.
  const answeringPhaseStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const socket = getSocket();

    if (!gameId) {
      dispatch({ type: 'SET_VALIDATING', payload: false });
      dispatch({ type: 'SET_GAME_ERROR', payload: 'Game not found or no longer available' });
      return;
    }

    // Build the auth payload for validateGame. Player credentials are keyed by gameId
    // (see player-storage.ts), so a single validateGame round trip suffices.
    const buildAuth = () => {
      if (isHost) {
        const t = (() => {
          try { return localStorage.getItem(HOST_TOKEN_KEY(gameId)) || ''; } catch { return ''; }
        })();
        return { hostToken: t };
      }
      const creds = getPlayerCreds(gameId);
      return creds ? { playerId: creds.playerId, playerToken: creds.playerToken } : {};
    };

    const urlParams = new URLSearchParams(window.location.search);
    const isPlayerParam = urlParams.get('player') === 'true';

    const validate = (isReconnect: boolean) => {
      socket.emit('validateGame', gameId, buildAuth(), (valid: boolean, gameData?: Game) => {
        if (isReconnect) {
          if (valid && gameData) dispatch({ type: 'RECONNECT_SYNC', payload: gameData });
          // On failure keep the current screen: the game may have finished and been
          // released, and the final-results screen is already showing.
          return;
        }
        dispatch({ type: 'SET_VALIDATING', payload: false });
        if (valid && gameData) {
          dispatch({ type: 'SET_GAME_DATA', payload: { game: gameData, status: gameData.status } });
        } else {
          dispatch({
            type: 'SET_GAME_ERROR',
            payload: isPlayerParam
              ? 'Unable to rejoin game. You may have been removed.'
              : 'Game not found or no longer available',
          });
          setTimeout(() => router.push('/'), 3000);
        }
      });
    };
    validate(false);

    // Socket.IO reconnects transparently, but the NEW server-side socket is not in the game
    // room and the server still holds the old socketId with isConnected=false (which, for the
    // host, leaves the grace timer running until the game auto-finishes). Re-validate with
    // the stored auth on every reconnect so the server swaps the socketId, rejoins the room,
    // clears the grace timer and re-syncs the current phase.
    const onReconnect = () => validate(true);
    socket.io.on('reconnect', onReconnect);

    socket.on('gameStarted', (gameData: Game) => dispatch({ type: 'GAME_STARTED', payload: gameData }));
    socket.on('thinkingPhase', (question: Question, thinkTime: number, deadline?: PhaseDeadline) =>
      dispatch({ type: 'START_THINKING_PHASE', payload: { question, thinkTime, deadline } })
    );
    socket.on('answeringPhase', (answerTime: number, deadline?: PhaseDeadline) => {
      answeringPhaseStartedAtRef.current = Date.now(); // Phase 8: local clock at phase start
      dispatch({ type: 'START_ANSWERING_PHASE', payload: { answerTime, deadline } });
    });
    socket.on('questionEnded', () => dispatch({ type: 'WAITING_FOR_RESULTS' }));
    socket.on('personalResult', (result: PersonalResult) =>
      dispatch({ type: 'PERSONAL_RESULT', payload: result })
    );
    socket.on('hostResults', (stats: GameStats) => dispatch({ type: 'QUESTION_ENDED', payload: stats }));
    socket.on('leaderboardShown', (leaderboardData: Player[], gameData: Game) =>
      dispatch({ type: 'SHOW_LEADERBOARD', payload: { leaderboard: leaderboardData, game: gameData } })
    );
    socket.on('myStanding', (standing: PlayerStanding) => dispatch({ type: 'MY_STANDING', payload: standing }));
    socket.on('gameFinished', (scores: Player[]) => dispatch({ type: 'GAME_FINISHED', payload: scores }));
    socket.on('playerAnswered', (answered: number, total: number) =>
      dispatch({ type: 'ANSWERED_COUNT', payload: { answered, total } })
    );
    socket.on('gameLogs', (tsvData: string, filename: string) => {
      const blob = new Blob([tsvData], { type: 'text/tab-separated-values' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    });
    socket.on('waitForNextQuestion', () => {
      // Late joiner during answering — just stay on waiting screen
      console.log('[client] Server says: wait for next question');
    });
    socket.on('hostReconnecting', () => dispatch({ type: 'HOST_RECONNECTING', payload: true }));
    socket.on('hostReconnected', () => dispatch({ type: 'HOST_RECONNECTING', payload: false }));
    socket.on('answerRejected', (reason: string) => dispatch({ type: 'ANSWER_REJECTED', payload: reason }));
    socket.on('kicked', (reason: string) => {
      // Phase 7: the server says why (same identity from another device, removed by host...).
      alert(reason || 'You were removed from the game.');
      console.warn('[client] kicked:', reason);
      router.push('/');
    });

    return () => {
      socket.io.off('reconnect', onReconnect);
      socket.off('gameStarted');
      socket.off('thinkingPhase');
      socket.off('answeringPhase');
      socket.off('questionEnded');
      socket.off('hostResults');
      socket.off('personalResult');
      socket.off('leaderboardShown');
      socket.off('myStanding');
      socket.off('gameFinished');
      socket.off('playerAnswered');
      socket.off('gameLogs');
      socket.off('waitForNextQuestion');
      socket.off('hostReconnecting');
      socket.off('hostReconnected');
      socket.off('answerRejected');
      socket.off('kicked');
    };
  }, [gameId, isHost, router]);

  // One interval per phase, recomputing timeLeft from the absolute local deadline. The
  // previous effect depended on timeLeft and was torn down and rebuilt every second, so
  // each tick inherited the scheduling drift of the one before it; on a slow link the
  // phone's "0" could land hundreds of ms early and the last-second tap was never sent.
  // SET_TIME_LEFT is a no-op when the integer second hasn't changed, so 250 ms polling
  // costs no re-renders.
  useEffect(() => {
    const deadlineAt = state.deadlineAt;
    if (deadlineAt === null || (state.gameStatus !== 'thinking' && state.gameStatus !== 'answering')) return;
    const tick = () => {
      dispatch({ type: 'SET_TIME_LEFT', payload: Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)) });
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [state.deadlineAt, state.gameStatus]);

  useEffect(() => {
    if (!state.notice) return;
    const t = setTimeout(() => dispatch({ type: 'CLEAR_NOTICE' }), 4000);
    return () => clearTimeout(t);
  }, [state.notice]);

  const notice = state.notice ? (
    <div
      role="status"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] max-w-[92vw] px-4 py-2 rounded-lg bg-black/85 text-white text-sm shadow-lg"
    >
      {state.notice}
    </div>
  ) : null;

  const submitAnswer = (answer: number | number[]) => {
    if (state.hasAnswered || !state.currentQuestion || state.phase !== 'answering') return;
    if (state.qEpoch === null) {
      console.warn('[submitAnswer] no qEpoch yet — answeringPhase not received');
      return;
    }
    dispatch({ type: 'SUBMIT_ANSWER', payload: { answer } });
    if (!gameId) return;
    const creds = getPlayerCreds(gameId);
    if (!creds) {
      console.warn('[submitAnswer] missing playerId/playerToken — answer cannot be submitted');
      return;
    }
    const { playerId: persistentId, playerToken } = creds;
    const socket = getSocket();
    // Phase 8: client-perceived time elapsed since answering phase started locally
    const clientPerceivedMs =
      answeringPhaseStartedAtRef.current != null
        ? Math.max(0, Date.now() - answeringPhaseStartedAtRef.current)
        : undefined;
    socket.emit(
      'submitAnswer',
      gameId,
      state.currentQuestion.id,
      answer,
      persistentId,
      playerToken,
      state.qEpoch,
      clientPerceivedMs
    );
  };

  const getHostToken = (): string => {
    // Read URL directly to bypass any stale React closure / useParams transient.
    const path = typeof window === 'undefined' ? '' : window.location.pathname;
    const id = path.split('/')[2] || gameId;
    if (!id) return '';
    try { return localStorage.getItem(HOST_TOKEN_KEY(id)) || ''; } catch { return ''; }
  };

  const nextQuestion = () => {
    const socket = getSocket();
    if (!gameId) return;
    socket.emit('nextQuestion', gameId, getHostToken());
  };

  const showLeaderboard = () => {
    const socket = getSocket();
    if (!gameId) return;
    const tok = getHostToken();
    socket.emit('showLeaderboard', gameId, tok);
  };

  const downloadLogs = () => {
    const socket = getSocket();
    if (!gameId) return;
    socket.emit('downloadGameLogs', gameId, getHostToken());
  };

  const skipQuestion = () => {
    const socket = getSocket();
    if (!gameId) return;
    socket.emit('skipQuestion', gameId, getHostToken());
  };

  const restartQuestion = () => {
    const socket = getSocket();
    if (!gameId) return;
    socket.emit('restartQuestion', gameId, getHostToken());
  };

  if (state.isValidating) return <GameValidationScreen />;
  if (state.gameError) return <GameErrorScreen error={state.gameError} />;
  if (state.gameStatus === 'waiting' || state.gameStatus === 'preparation') {
    return <GameWaitingScreen gameStatus={state.gameStatus} />;
  }
  if (state.gameStatus === 'leaderboard' && isHost) {
    return (
      <GameLeaderboardScreen
        leaderboard={state.leaderboard}
        game={state.game}
        onNextQuestion={nextQuestion}
      />
    );
  }
  // Players get the standings too. Without this branch they fall through to
  // GameFallbackScreen and just see "Waiting for the host...", even though the
  // server already broadcast the leaderboard to them.
  if (state.gameStatus === 'leaderboard') {
    return <PlayerLeaderboardScreen leaderboard={state.leaderboard} game={state.game} me={state.myStanding} />;
  }
  if (state.gameStatus === 'finished') {
    return (
      <GameFinalResultsScreen
        finalScores={state.finalScores}
        isHost={isHost}
        onDownloadLogs={downloadLogs}
        gameId={gameId ?? undefined}
      />
    );
  }
  if (state.gameStatus === 'thinking' && state.phase === 'thinking' && state.currentQuestion) {
    return (
      <>
        <GameThinkingPhaseScreen
          currentQuestion={state.currentQuestion}
          timeLeft={state.timeLeft}
          game={state.game}
          isHost={isHost}
          isPlayer={isPlayer}
          questionIndex={state.questionIndex}
        />
        {isHost && <HostPhaseControls onSkip={skipQuestion} onRestart={restartQuestion} />}
      </>
    );
  }
  if (state.gameStatus === 'waiting-results') {
    return <>{notice}<GameWaitingForResultsScreen isHost={isHost} /></>;
  }
  if (state.gameStatus === 'answering' && state.phase === 'answering' && state.currentQuestion) {
    return (
      <>
        {notice}
        <GameAnsweringPhaseScreen
          currentQuestion={state.currentQuestion}
          timeLeft={state.timeLeft}
          game={state.game}
          isHost={isHost}
          isPlayer={isPlayer}
          onSubmitAnswer={submitAnswer}
          hasAnswered={state.hasAnswered}
          questionIndex={state.questionIndex}
          answeredCount={state.answeredCount}
        />
        {isHost && <HostPhaseControls onSkip={skipQuestion} onRestart={restartQuestion} />}
      </>
    );
  }
  if (state.gameStatus === 'results') {
    return (
      <>
      {notice}
      <GameResultsPhaseScreen
        isHost={isHost}
        isPlayer={isPlayer}
        questionStats={state.questionStats}
        personalResult={state.personalResult}
        onShowLeaderboard={showLeaderboard}
        currentQuestion={state.currentQuestion}
        selectedAnswer={state.selectedAnswer}
        game={state.game}
      />
      </>
    );
  }
  return <GameFallbackScreen />;
}
