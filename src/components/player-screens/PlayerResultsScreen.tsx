'use client';

import { Check, X } from 'lucide-react';
import { getChoiceColor } from '@/lib/palette';
import type { PersonalResult, Question } from '@/types/game';
import { getCorrectAnswerSet, normalizeSubmission } from '@/lib/game/questionType';

/**
 * Player's per-question results screen. Designed to fit a typical mobile
 * viewport (~520-700px tall after browser chrome) without page-level scroll.
 *
 * Layout strategy:
 * - Card is `h-full flex flex-col overflow-hidden` — pins to its container.
 * - Header + bottom info row are `shrink-0` so they never get squeezed.
 * - The middle "question + options + explanation" region is the only place
 *   that can overflow; it uses `flex-1 min-h-0 overflow-y-auto` so it scrolls
 *   internally instead of breaking the page on extreme small viewports.
 * - Points + position collapse to a side-by-side grid on mobile to save height.
 */
interface PlayerResultsScreenProps {
  personalResult: PersonalResult;
  currentQuestion?: Question;
  selectedAnswer?: number | number[] | null;
}

export default function PlayerResultsScreen({
  personalResult,
  currentQuestion,
  selectedAnswer
}: PlayerResultsScreenProps) {
  const showAnswers = !!currentQuestion;
  const correctSet = currentQuestion ? getCorrectAnswerSet(currentQuestion) : null;
  const picked = new Set(normalizeSubmission(selectedAnswer ?? null));

  return (
    <div className="bg-white rounded-xl p-3 sm:p-5 border-4 border-black shadow-xl text-center w-full h-full flex flex-col overflow-hidden">
      {/* Result header */}
      <h1 className="shrink-0 text-2xl sm:text-3xl text-black mb-2 font-subtitle">
        {personalResult.wasCorrect ? 'Correct!' : 'Incorrect!'}
      </h1>

      {/* Question + options + explanation — only region that can overflow */}
      {showAnswers && currentQuestion && correctSet && (
        <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50 rounded-lg p-2 sm:p-3 mb-2 border border-gray-200 text-left">
          <p className="text-sm font-semibold text-black mb-1 leading-snug break-words">
            {currentQuestion.question}
          </p>
          {currentQuestion.questionType === 'multi' && (
            <p className="text-[10px] font-semibold text-yellow-800 mb-1">Multi-select</p>
          )}
          <div className="space-y-1 mt-2">
            {currentQuestion.options.map((opt, idx) => {
              const isCorrect = correctSet.has(idx);
              const isPlayerChoice = picked.has(idx);
              const baseColor = getChoiceColor(idx);
              let ring = '';
              let bg = 'bg-gray-100 text-gray-500';
              let icon: React.ReactNode = null;
              if (isCorrect) {
                bg = `${baseColor} text-white`;
                ring = 'ring-2 ring-green-400';
                icon = <Check className="w-4 h-4 shrink-0" />;
              } else if (isPlayerChoice) {
                bg = `${baseColor} text-white opacity-70`;
                ring = 'ring-2 ring-red-400';
                icon = <X className="w-4 h-4 shrink-0" />;
              }
              return (
                <div key={idx} className={`flex items-center gap-2 px-2 py-1 rounded ${bg} ${ring}`}>
                  <span className="shrink-0 w-5 h-5 rounded-full bg-white/30 flex items-center justify-center font-bold text-[10px]">
                    {['A', 'B', 'C', 'D'][idx]}
                  </span>
                  <span className="flex-1 text-left text-xs sm:text-sm font-medium leading-snug break-words">
                    {opt}
                  </span>
                  {icon}
                </div>
              );
            })}
          </div>
          {personalResult.explanation && (
            <div className="mt-2 pt-2 border-t border-gray-200">
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wide mb-0.5">
                Explanation
              </p>
              <p className="text-xs text-gray-700 leading-snug">
                {personalResult.explanation}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Bottom info row — points + position side by side */}
      <div className="shrink-0 grid grid-cols-2 gap-2">
        <div className="bg-gray-50 rounded-lg p-2 border border-gray-200">
          <p className="text-[10px] text-gray-600">Points earned</p>
          <p className="text-xl sm:text-2xl font-bold text-black leading-tight">+{personalResult.pointsEarned}</p>
          <div className="flex flex-wrap justify-center gap-1 mt-1">
            {(personalResult.streakBonus ?? 0) > 0 && (
              <span className="text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-yellow-400 text-black border border-black font-bold">
                🔥 {personalResult.currentStreak} · +{personalResult.streakBonus}
              </span>
            )}
            {(personalResult.firstCorrectBonus ?? 0) > 0 && (
              <span className="text-[10px] inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-black text-yellow-400 border border-black font-bold">
                🥇 +{personalResult.firstCorrectBonus}
              </span>
            )}
          </div>
          <p className="text-[10px] text-gray-600 mt-0.5">Total: {personalResult.totalScore}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-2 border border-gray-200">
          <p className="text-[10px] text-gray-600">Current position</p>
          <p className="text-xl sm:text-2xl font-bold text-black leading-tight">#{personalResult.position}</p>
          {personalResult.pointsBehind > 0 ? (
            <p className="text-[10px] text-gray-600 mt-0.5 leading-snug">
              {personalResult.pointsBehind} behind <span className="font-bold text-black">{personalResult.nextPlayerName}</span>
            </p>
          ) : personalResult.position > 1 ? (
            // pointsBehind is 0 but we are not first: tied with the player above. Without
            // this branch a whole class tied at 0 after Q1 all read "In the lead!" at #87.
            <p className="text-[10px] text-gray-600 mt-0.5 leading-snug">
              Tied with <span className="font-bold text-black">{personalResult.nextPlayerName}</span>
            </p>
          ) : (
            <p className="text-[10px] font-semibold mt-0.5 leading-snug">In the lead!</p>
          )}
        </div>
      </div>

      <p className="shrink-0 text-[10px] text-gray-500 mt-1">Waiting for host…</p>
    </div>
  );
}
