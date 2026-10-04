'use client';

import { useEffect } from 'react';
import { Question } from '@/types/game';
import { getChoiceColor } from '@/lib/palette';
import { useCountdownMusic } from '@/lib/useCountdownMusic';
import Image from 'next/image';

interface HostAnsweringScreenProps {
  currentQuestion: Question;
  timeLeft: number;
  answerTime: number;
  answeredCount?: { answered: number; total: number } | null;
}

export default function HostAnsweringScreen({ 
  currentQuestion,
  answeredCount = null,
}: HostAnsweringScreenProps) {
  const { playRandomCountdown, stopMusic } = useCountdownMusic();

  // Play random countdown music when the answering phase starts (only once)
  useEffect(() => {
    playRandomCountdown();
    
    // Cleanup function to stop music when component unmounts
    return () => {
      stopMusic();
    };
  }, [playRandomCountdown, stopMusic]); // Add missing dependencies

  // Choice button colors for players - using palette
  const choiceColors = [
    getChoiceColor(0), // A - Red
    getChoiceColor(1), // B - Blue
    getChoiceColor(2), // C - Yellow
    getChoiceColor(3)  // D - Green
  ];

  return (
    <div className="bg-white rounded-lg p-4 sm:p-6 border border-gray-300 shadow-[0px_20px_30px_-10px_rgba(0,_0,_0,_0.1)] flex-1 min-h-0 flex flex-col overflow-hidden">

      {/* Question Text */}
      <h1 className="text-xl sm:text-3xl text-black text-center leading-tight mb-1 sm:mb-2 font-subtitle shrink-0">
        {currentQuestion.question}
      </h1>
      {currentQuestion.questionType === 'multi' && (
        <p className="text-center text-xs sm:text-base font-bold text-yellow-700 mb-2 sm:mb-3 shrink-0">
          Pick all that apply
        </p>
      )}

      {/* Question Image */}
      {currentQuestion.image && (
        <div className="mb-3 sm:mb-4 shrink-0 flex justify-center">
          <Image src={currentQuestion.image} alt={currentQuestion.question} width={600} height={400} className="max-h-32 sm:max-h-48 w-auto rounded-lg object-contain" />
        </div>
      )}

      {/* Answer Choices */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3 flex-1 min-h-0 overflow-y-auto">
        {currentQuestion.options.map((option, index) => (
          <div
            key={index}
            className={`p-3 sm:p-4 rounded-xl border-2 ${choiceColors[index].split(' ')[0]} ${choiceColors[index].split(' ')[1]} ${choiceColors[index].split(' ')[2]} text-white`}
          >
            <div className="flex items-center gap-3 sm:gap-4">
              <div className="w-9 h-9 sm:w-11 sm:h-11 bg-white/20 rounded-xl flex items-center justify-center text-white font-bold text-lg sm:text-xl shrink-0">
                {String.fromCharCode(65 + index)}
              </div>
              <span className="font-semibold text-base sm:text-lg break-words">{option}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="text-center mt-2 sm:mt-3 text-gray-600 text-xs sm:text-sm shrink-0" aria-live="polite">
        {answeredCount
          ? `${answeredCount.answered} of ${answeredCount.total} players have answered`
          : 'Players are choosing their answers on their devices'}
      </div>
    </div>
  );
}