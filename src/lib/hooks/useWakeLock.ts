import { useEffect } from 'react';

/**
 * Keeps the screen awake while `active` is true (Screen Wake Lock API).
 * Phones dimming in the lobby or mid-question cost students answers, and a
 * locked screen can suspend the socket. The browser drops the lock whenever
 * the tab is hidden, so we re-request it when the page becomes visible again.
 * Silently does nothing on browsers without support (older iOS, Firefox).
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const request = async () => {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) lock.release().catch(() => {});
        else sentinel = lock;
      } catch {
        // Denied (battery saver, permissions policy). Not worth surfacing.
      }
    };

    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', request);
      sentinel?.release().catch(() => {});
    };
  }, [active]);
}
