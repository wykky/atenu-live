import type { Game, Question, GameStats, PersonalResult } from '@/types/game';
import { isAnswerCorrect, normalizeSubmission } from './questionType';

export class QuestionManager {
  startNextQuestion(game: Game): Question | null {
    const nextIndex = game.currentQuestionIndex + 1;
    
    if (nextIndex >= game.questions.length) {
      return null; // No more questions
    }

    game.currentQuestionIndex = nextIndex;
    // Update status to indicate a question is active - GameplayLoop will manage detailed phases
    game.status = 'preparation';

    const question = game.questions[nextIndex];
    // Removed console.log
    
    return question;
  }

  getCurrentQuestion(game: Game): Question | undefined {
    if (game.currentQuestionIndex < 0 || game.currentQuestionIndex >= game.questions.length) {
      return undefined;
    }
    return game.questions[game.currentQuestionIndex];
  }

  getQuestionStats(game: Game): GameStats | undefined {
    const question = this.getCurrentQuestion(game);
    if (!question) return undefined;

    const players = game.players.filter(p => !p.isHost);
    const totalPlayers = players.length;
    
    // Count answers for each option
    const answerCounts = new Array(question.options.length).fill(0);
    let correctAnswers = 0;
    
    players.forEach(player => {
      if (player.currentAnswer === undefined) return;
      // Multi-select: increment count for every option the player picked. Percentages
      // can sum >100% — that's expected and useful as a "how many considered each option".
      const picked = normalizeSubmission(player.currentAnswer);
      picked.forEach((idx) => {
        if (idx >= 0 && idx < answerCounts.length) answerCounts[idx]++;
      });
      if (isAnswerCorrect(question, player.currentAnswer)) {
        correctAnswers++;
      }
    });

    // Calculate percentages
    const answers = answerCounts.map((count, index) => ({
      optionIndex: index,
      count,
      percentage: totalPlayers > 0 ? Math.round((count / totalPlayers) * 100) : 0
    }));

    return {
      question,
      answers,
      correctAnswers,
      totalPlayers
    };
  }

  /**
   * Per-player results for the current question, computed in ONE pass: sort the
   * leaderboard once and build an id -> position map, instead of re-sorting and
   * re-scanning for every player (was O(n^2) per results phase, 200 players = 40k
   * comparisons x 200 sorts).
   */
  getPersonalResults(game: Game): Map<string, PersonalResult> {
    const results = new Map<string, PersonalResult>();
    const question = this.getCurrentQuestion(game);
    if (!question) return results;

    const leaderboard = game.players
      .filter(p => !p.isHost)
      .sort((a, b) => b.score - a.score);

    leaderboard.forEach((player, idx) => {
      const position = idx + 1;
      const playerAbove = idx > 0 ? leaderboard[idx - 1] : undefined;
      results.set(player.id, {
        wasCorrect: isAnswerCorrect(question, player.currentAnswer),
        // Canonical: points cached by PlayerManager.updateScores. Same number as the TSV
        // row and the score delta on the live leaderboard — no recomputation, no drift.
        pointsEarned: player.lastPointsEarned ?? 0,
        totalScore: player.score,
        position,
        pointsBehind: playerAbove ? playerAbove.score - player.score : 0,
        nextPlayerName: playerAbove ? playerAbove.name : null,
        explanation: question.explanation,
        currentStreak: player.currentStreak ?? 0,
        streakBonus: player.streakBonus ?? 0,
        firstCorrectBonus: player.firstCorrectBonus ?? 0,
      });
    });
    return results;
  }

  hasAllPlayersAnswered(game: Game): boolean {
    const activePlayers = game.players.filter(p => !p.isHost && p.isConnected);
    return activePlayers.every(p => p.currentAnswer !== undefined);
  }

  getAnsweredPlayerCount(game: Game): number {
    return game.players.filter(p => !p.isHost && p.currentAnswer !== undefined).length;
  }

  getTotalActivePlayerCount(game: Game): number {
    return game.players.filter(p => !p.isHost && p.isConnected).length;
  }

  isLastQuestion(game: Game): boolean {
    return game.currentQuestionIndex >= game.questions.length - 1;
  }

  getQuestionProgress(game: Game): { current: number; total: number } {
    return {
      current: game.currentQuestionIndex + 1,
      total: game.questions.length
    };
  }
} 