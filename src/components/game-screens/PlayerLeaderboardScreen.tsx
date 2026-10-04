'use client';

import { useEffect, useState } from 'react';
import { getGradient } from '@/lib/palette';
import type { Player, Game, PlayerStanding } from '@/types/game';

import { getPlayerId } from '@/lib/player-storage';
// Top 3 mid-game, not 5: on a phone, 5 rows plus the player's own row plus the
// "next question" banner crowds the screen. 3 also means every visible row is a
// podium medal. The player's own standing is always shown regardless of rank.
const TOP_N = 3;

/** Medal for the podium, plain number after that. */
function rankBadge(rank: number) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `${rank}`;
}

function Row({ player, rank, isMe }: { player: Player; rank: number; isMe: boolean }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 ${
        isMe ? 'bg-yellow-300 border-black shadow-[3px_3px_0_0_#000]' : 'bg-white border-black/15'
      }`}
    >
      <span className="w-7 shrink-0 text-center text-base font-bold text-black">
        {rankBadge(rank)}
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold text-black">
        {player.name}
        {isMe && <span className="ml-1.5 text-xs font-bold uppercase tracking-wide">you</span>}
      </span>
      <span className="shrink-0 font-bold tabular-nums text-black">
        {player.score.toLocaleString()}
      </span>
    </div>
  );
}

/**
 * What a PLAYER sees during the 'leaderboard' phase.
 *
 * Previously players had no branch for this phase at all and fell through to
 * GameFallbackScreen ("Waiting for the host..."), even though the server already
 * broadcasts `leaderboardShown` to the whole room — so the data was sitting
 * unused on every phone. This renders the top 5 plus the player's own standing,
 * which is the Kahoot between-questions beat.
 *
 * The player's own row is always shown: if they placed outside the top 5 it is
 * pinned below the list rather than hidden, so nobody is left without feedback.
 */
export default function PlayerLeaderboardScreen({
  leaderboard,
  game,
  me: myStanding = null,
}: {
  // Top-N rows only (the server trims for players); the player's own row comes via `me`.
  leaderboard: Player[];
  game: Game | null;
  me?: PlayerStanding | null;
}) {
  // localStorage is read after mount to keep server and first client render identical.
  const [myId, setMyId] = useState<string | null>(null);
  useEffect(() => {
    if (!game?.id) return;
    setMyId(getPlayerId(game.id));
  }, [game?.id]);

  // Server sets a tie-aware `rank` (1,1,3,...). Fall back to list position so a
  // missing rank shows a sensible number instead of a "0" badge for everyone.
  const players = leaderboard
    .filter((p) => !p.isHost)
    .map((p, i) => ({ player: p, rank: p.rank ?? i + 1 }));
  const top = players.slice(0, TOP_N);
  const meInList = myId ? players.find((e) => e.player.id === myId) : undefined;
  // Own standing: from the trimmed list if we are in it, else from the per-socket
  // myStanding payload (the server no longer sends 200 rows to every phone).
  const me = meInList
    ?? (myStanding && myId
      ? { player: { id: myId, name: myStanding.name, score: myStanding.score, isHost: false, isConnected: true } as Player, rank: myStanding.rank }
      : undefined);
  const meOutsideTop = me && !top.some((e) => e.player.id === me.player.id) ? me : undefined;

  const total = game?.totalQuestions ?? 0;
  const done = Math.min((game?.currentQuestionIndex ?? 0) + 1, total || Infinity);

  return (
    <div className={`h-dvh overflow-hidden ${getGradient('waiting')} flex flex-col p-4 sm:p-6`}>
      {/* justify-center, and the list is NOT flex-1: with only a couple of players
          a growing list would pin the "next question" banner to the bottom of the
          screen with a large dead gap above it. Centring keeps the whole block
          together at any player count, and the list still shrinks + scrolls when
          the class is big. */}
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 min-h-0">
        <div className="shrink-0 text-center">
          <h1 className="text-2xl font-bold text-black sm:text-3xl">Leaderboard</h1>
          {total > 0 && (
            <p className="mt-1 text-sm text-gray-600">
              Question {done} of {total} complete
            </p>
          )}
        </div>

        <div className="space-y-2 overflow-y-auto min-h-0">
          {top.length === 0 ? (
            <p className="text-center text-gray-600">No scores yet.</p>
          ) : (
            top.map((e) => (
              <Row
                key={e.player.id}
                player={e.player}
                rank={e.rank}
                isMe={!!me && e.player.id === me.player.id}
              />
            ))
          )}

          {meOutsideTop && (
            <>
              <p className="pt-1 text-center text-xs font-semibold tracking-wide text-gray-500">
                YOUR POSITION
              </p>
              <Row player={meOutsideTop.player} rank={meOutsideTop.rank} isMe />
            </>
          )}
        </div>

        <div className="shrink-0 flex justify-center">
          <div className="flex items-center gap-3 rounded-2xl border-4 border-black bg-white px-5 py-3 shadow-[4px_4px_0_0_#000]">
            <span className="text-lg font-bold text-black sm:text-xl">
              Next question coming up
            </span>
            <span className="flex gap-1" aria-hidden="true">
              <span className="h-2 w-2 animate-bounce rounded-full bg-black [animation-delay:-0.3s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-black [animation-delay:-0.15s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-black" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
