'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { applyUpdate, initPwa, usePwa } from '@/lib/pwa';
import InstallPrompt from './InstallPrompt';

// Pages where a floating install banner is welcome. Never on /join (students
// are typing a PIN against the clock) or in a game (the podium shows an
// inline prompt instead).
const BANNER_PATHS = new Set(['/', '/library', '/how-it-works']);

/** Mounted once in the root layout: registers the SW, shows update + install UI. */
export default function PwaRoot() {
  const pathname = usePathname() ?? '/';
  const { updateReady } = usePwa();

  useEffect(() => initPwa(), []);

  // Never reload someone mid-game or mid-lobby; they get the update next page.
  const inGame = pathname.startsWith('/game') || pathname.startsWith('/host');
  const showUpdate = updateReady && !inGame;

  return (
    <>
      {showUpdate && (
        <div className="fixed inset-x-3 top-3 z-[60] mx-auto max-w-md pt-[env(safe-area-inset-top)]" role="status">
          <div className="flex items-center justify-between gap-3 rounded-xl border-2 border-black bg-black px-4 py-3 text-white shadow-[4px_4px_0_0_#FFC600]">
            <span className="text-sm font-semibold">A new version of Atenu Live is ready.</span>
            <button
              type="button"
              onClick={applyUpdate}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-yellow-400 px-3 py-1.5 text-sm font-bold text-black hover:bg-yellow-300 cursor-pointer"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Update
            </button>
          </div>
        </div>
      )}
      {BANNER_PATHS.has(pathname) && <InstallPrompt variant="banner" placement={`banner:${pathname}`} />}
    </>
  );
}
