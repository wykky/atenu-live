'use client';

import { useState } from 'react';
import { LogOut, Download, Share2, Check } from 'lucide-react';
import PageLayout from '@/components/PageLayout';
import Leaderboard from '@/components/Leaderboard';
import type { Player } from '@/types/game';

interface GameFinalResultsScreenProps {
  finalScores: Player[];
  isHost: boolean;
  onDownloadLogs: () => void;
  gameId?: string;
}

export default function GameFinalResultsScreen({
  finalScores,
  isHost,
  onDownloadLogs,
  gameId
}: GameFinalResultsScreenProps) {
  const [shareCopied, setShareCopied] = useState(false);

  const handleShareResults = async () => {
    if (!gameId) return;
    const url = `${window.location.origin}/leaderboard/${gameId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Older browsers / permission denied — fall back to a prompt so the
      // host can still grab the URL by hand.
      window.prompt('Copy this link:', url);
    }
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const hostButtons = [
    ...(gameId
      ? [
          {
            text: shareCopied ? 'Copied!' : 'Share results',
            onClick: handleShareResults,
            icon: shareCopied ? Check : Share2,
            iconPosition: 'left' as const,
            variant: 'primary' as const
          }
        ]
      : []),
    {
      text: 'Download game logs',
      onClick: onDownloadLogs,
      icon: Download,
      iconPosition: 'left' as const,
      variant: 'primary' as const
    },
    {
      text: 'Back to home',
      onClick: () => window.location.href = '/',
      icon: LogOut,
      iconPosition: 'right' as const,
      variant: 'primary' as const
    }
  ];

  const playerButtons = [
    {
      text: 'Back to home',
      onClick: () => window.location.href = '/',
      icon: LogOut,
      iconPosition: 'right' as const
    }
  ];

  return (
    <PageLayout gradient="waiting" maxWidth="4xl" showLogo={false}>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="bg-white border-4 border-black rounded-2xl p-3 sm:p-5 shadow-xl flex-1 min-h-0 flex flex-col overflow-hidden">
          <Leaderboard
            players={finalScores}
            title="Final leaderboard"
            subtitle="Game is now over!"
            buttons={isHost ? hostButtons : playerButtons}
            showIcon={isHost}
            compact
          />
        </div>
      </div>
    </PageLayout>
  );
}