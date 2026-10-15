'use client';

import { useEffect, useState } from 'react';
import { Download, Share, SquarePlus, X } from 'lucide-react';
import { dismissInstall, isInstallDismissed, promptInstall, track, usePwa } from '@/lib/pwa';

interface InstallPromptProps {
  /** "banner" floats at the bottom of the screen; "inline" sits in the page flow. */
  variant: 'banner' | 'inline';
  /** Analytics label for where the prompt was shown. */
  placement: string;
}

/**
 * "Add Atenu Live to your home screen" card.
 * Android/desktop Chrome: one-tap native install.
 * iPhone Safari: short Share > Add to Home Screen instructions (no API exists).
 * Hidden when already installed, unsupported, or dismissed in the last 14 days.
 */
export default function InstallPrompt({ variant, placement }: InstallPromptProps) {
  const { canInstall, isIosSafari, isStandalone } = usePwa();
  // Read localStorage after mount so server and first client render match.
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => setDismissed(isInstallDismissed()), []);

  const visible = !isStandalone && !dismissed && (canInstall || isIosSafari);

  useEffect(() => {
    if (visible) track('pwa_install_shown', { placement, kind: canInstall ? 'native' : 'ios' });
  }, [visible, placement, canInstall]);

  if (!visible) return null;

  const close = () => {
    dismissInstall(placement);
    setDismissed(true);
  };

  const wrapper =
    variant === 'banner'
      ? 'fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md animate-[al-slide-up_300ms_ease-out] pb-[env(safe-area-inset-bottom)]'
      : 'w-full max-w-md mx-auto';

  return (
    <div className={wrapper} role="region" aria-label="Install Atenu Live">
      <div className="relative flex items-start gap-3 rounded-2xl border-4 border-black bg-white p-4 shadow-[4px_4px_0_0_#000]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pwa/icon-192.png" alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1 pr-6 text-left">
          <p className="font-bold text-black">Get the Atenu Live app</p>
          {canInstall ? (
            <>
              <p className="text-sm text-gray-700">Join games in one tap from your home screen. Free, and it uses almost no storage.</p>
              <button
                type="button"
                onClick={() => promptInstall(placement)}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border-2 border-black bg-yellow-400 px-4 py-2 text-sm font-semibold text-black hover:bg-black hover:text-yellow-400 cursor-pointer"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Install
              </button>
            </>
          ) : (
            <p className="text-sm text-gray-700">
              Tap <Share className="inline h-4 w-4 align-text-bottom" aria-label="Share" /> below, then{' '}
              <span className="whitespace-nowrap font-semibold">
                <SquarePlus className="inline h-4 w-4 align-text-bottom" aria-hidden="true" /> Add to Home Screen
              </span>
              .
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Not now"
          className="absolute right-2 top-2 rounded-full p-1.5 text-gray-500 hover:bg-gray-100 hover:text-black cursor-pointer"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
