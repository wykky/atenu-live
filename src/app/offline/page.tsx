/**
 * Offline fallback served by public/sw.js when a navigation fails.
 * Deliberately plain: no client JS, no session lookup, no fonts that need the
 * network. Only the CSS bundle is precached alongside it.
 */

import type { Metadata } from 'next';
import { WifiOff } from 'lucide-react';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'You are offline',
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <main className="min-h-dvh bg-yellow-400 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white border-4 border-black rounded-2xl p-6 text-center shadow-[6px_6px_0_0_#000]">
        <WifiOff className="mx-auto mb-4 h-12 w-12 text-black" aria-hidden="true" />
        <h1 className="text-2xl font-black text-black mb-2">No internet connection</h1>
        <p className="text-gray-700 mb-6">
          Live games need the internet. Check your data or Wi-Fi, then try again.
        </p>
        {/* A plain link, so it works without JavaScript. */}
        <a
          href="/join"
          className="inline-flex w-full items-center justify-center rounded-lg border-2 border-black bg-yellow-400 px-6 py-3 font-semibold text-black hover:bg-black hover:text-yellow-400"
        >
          Try again
        </a>
      </div>
    </main>
  );
}
