'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Download, RefreshCw, Share, SquarePlus, X } from 'lucide-react';
import { applyUpdate, dismissInstall, initPwa, isInstallDismissed, promptInstall, track, usePwa } from '@/lib/pwa';

/**
 * Mounted once in the root layout. Registers the service worker everywhere,
 * but the only visible PWA UI is one small round icon, bottom-right of the
 * front page:
 *   - new version waiting  -> refresh icon, tap reloads into it
 *   - installable (Chrome) -> download icon, tap opens the native prompt
 *   - iPhone Safari        -> download icon, tap shows Add-to-Home-Screen steps
 * Nothing shows on any other page, so games and the PIN screen stay clean.
 */
export default function PwaRoot() {
  const pathname = usePathname() ?? '/';
  const { updateReady, canInstall, isIosSafari, isStandalone } = usePwa();
  const [dismissed, setDismissed] = useState(true);
  const [iosHelpOpen, setIosHelpOpen] = useState(false);

  useEffect(() => initPwa(), []);
  // Read localStorage after mount so server and first client render match.
  useEffect(() => setDismissed(isInstallDismissed()), []);

  const installable = !isStandalone && !dismissed && (canInstall || isIosSafari);
  const mode = updateReady ? 'update' : installable ? 'install' : null;

  useEffect(() => {
    if (pathname === '/' && mode === 'install') {
      track('pwa_install_shown', { placement: 'home-icon', kind: canInstall ? 'native' : 'ios' });
    }
  }, [pathname, mode, canInstall]);

  if (pathname !== '/' || !mode) return null;

  const onClick = () => {
    if (mode === 'update') return applyUpdate();
    if (canInstall) return promptInstall('home-icon');
    setIosHelpOpen((open) => !open);
  };

  const label = mode === 'update' ? 'Update Atenu Live' : 'Install the Atenu Live app';
  const Icon = mode === 'update' ? RefreshCw : Download;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 pb-[env(safe-area-inset-bottom)]">
      {iosHelpOpen && (
        <div className="relative w-64 rounded-xl border-2 border-black bg-white p-3 pr-8 text-sm text-gray-800 shadow-[3px_3px_0_0_#000]" role="dialog" aria-label="Add to Home Screen">
          Tap <Share className="inline h-4 w-4 align-text-bottom" aria-label="Share" /> below, then{' '}
          <span className="whitespace-nowrap font-semibold">
            <SquarePlus className="inline h-4 w-4 align-text-bottom" aria-hidden="true" /> Add to Home Screen
          </span>
          .
          <button
            type="button"
            onClick={() => {
              dismissInstall('home-icon');
              setDismissed(true);
              setIosHelpOpen(false);
            }}
            aria-label="Not now"
            className="absolute right-1.5 top-1.5 rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-black cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className="relative flex h-11 w-11 items-center justify-center rounded-full border-2 border-black bg-yellow-400 text-black shadow-[2px_2px_0_0_#000] hover:bg-black hover:text-yellow-400 cursor-pointer"
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
        {mode === 'update' && (
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white bg-red-600" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
