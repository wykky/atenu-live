'use client';

import { Clock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getGradient, accent } from '@/lib/palette';
import QuestionCounter from '@/components/QuestionCounter';
import HostAnsweringScreen from '@/components/host-screens/HostAnsweringScreen';
import PlayerAnsweringScreen from '@/components/player-screens/PlayerAnsweringScreen';
import PlayerWaitingScreen from '@/components/player-screens/PlayerWaitingScreen';
import type { Question, Game } from '@/types/game';

/**
 * Smooth single-transition timer bar.
 * Starts at 100% on mount and animates linearly to 0% over `totalSeconds`.
 * No tick-based jumping — the bar visibly drains to empty before the next phase renders.
 * Below URGENT_THRESHOLD_SEC remaining, the bar flips red for tension.
 */
const URGENT_THRESHOLD_SEC = 5;

function SmoothTimerBar({ totalSeconds, timeLeft, resetKey }: { totalSeconds: number; timeLeft: number; resetKey: string | number }) {
  const [width, setWidth] = useState('100%');
  const raf = useRef<number | null>(null);
  useEffect(() => {
    setWidth('100%');
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      raf.current = requestAnimationFrame(() => setWidth('0%'));
    });
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [resetKey, totalSeconds]);
  const barColor = timeLeft <= URGENT_THRESHOLD_SEC ? 'bg-red-500' : accent.bg;
  return (
    <div className="w-full bg-gray-200 rounded-full h-2 mt-2 overflow-hidden">
      <div
        className={`${barColor} h-2 rounded-full`}
        style={{ width, transition: `width ${totalSeconds}s linear, background-color 500ms` }}
      />
    </div>
  );
}

interface GameAnsweringPhaseScreenProps {
  currentQuestion: Question;
  timeLeft: number;
  game: Game | null;
  isHost: boolean;
  isPlayer: boolean;
  onSubmitAnswer: (answer: number | number[]) => void;
  hasAnswered: boolean;
  questionIndex: number | null;
  // Host only: live "N of M answered" progress (null for players / before first answer).
  answeredCount?: { answered: number; total: number } | null;
}

export default function GameAnsweringPhaseScreen({
  currentQuestion,
  timeLeft,
  game,
  isHost,
  isPlayer,
  onSubmitAnswer,
  hasAnswered,
  questionIndex,
  answeredCount = null,
}: GameAnsweringPhaseScreenProps) {
  const showOnPlayers = game?.settings.showQuestionOnPlayers ?? true;

  // If player has answered, show full-screen waiting screen (no timer or container)
  if (isPlayer && hasAnswered) {
    return <PlayerWaitingScreen />;
  }

  return (
    <div className={`h-dvh overflow-hidden ${getGradient('answering')} p-3 sm:p-6 flex`}>
      <div className="container mx-auto max-w-4xl flex flex-col min-h-0 flex-1">
        {/* Progress counter — deliberately OUTSIDE the timer block below, which is
            desktop-only. Players answer on phones, so this has to render there too. */}
        <QuestionCounter questionIndex={questionIndex} total={game?.totalQuestions ?? 0} className="mb-2 shrink-0" />

        {/* Timer — compact, desktop only (mobile hides to save space) */}
        <div className="hidden sm:block text-center mb-3 shrink-0">
          <div className="flex items-center justify-center gap-2 mb-1">
            <Clock className="w-6 h-6 text-black" />
          </div>
          <p className="text-gray-600 text-sm">
            {isHost ? 'Players are choosing their answers' : 'Choose your answer!'}
          </p>
          <SmoothTimerBar
            totalSeconds={game?.settings.answerTime || 30}
            timeLeft={timeLeft}
            resetKey={currentQuestion.id}
          />
          {/* timeLeft preserved for accessibility */}
          <span className="sr-only">{timeLeft} seconds remaining</span>
        </div>

        {/* Host Screen - Show question and full answer choices */}
        {isHost && (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <HostAnsweringScreen
              currentQuestion={currentQuestion}
              timeLeft={timeLeft}
              answerTime={game?.settings.answerTime || 30}
              answeredCount={answeredCount}
            />
          </div>
        )}

        {/* Player Device - Show answer choices (and optionally question) */}
        {isPlayer && !hasAnswered && (
          <div className="flex-1 min-h-0 flex overflow-hidden">
            <PlayerAnsweringScreen
              onSubmitAnswer={onSubmitAnswer}
              question={showOnPlayers ? currentQuestion : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
