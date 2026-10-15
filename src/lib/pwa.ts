'use client';

/**
 * PWA client state: service-worker registration, the deferred install prompt,
 * and "new version ready" tracking. A tiny external store so any component
 * can read it with usePwa() without a context provider.
 */

import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  /** Chrome/Edge/Samsung: native install prompt is available. */
  canInstall: boolean;
  /** iPhone/iPad Safari: no prompt API, show Share > Add to Home Screen. */
  isIosSafari: boolean;
  /** Already running as an installed app. */
  isStandalone: boolean;
  /** A new service worker is waiting; reload to update. */
  updateReady: boolean;
}

const SERVER_STATE: PwaState = { canInstall: false, isIosSafari: false, isStandalone: false, updateReady: false };

let state: PwaState = SERVER_STATE;
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let waitingWorker: ServiceWorker | null = null;
let reloadOnControllerChange = false;
let initialized = false;
const listeners = new Set<() => void>();

function setState(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function track(event: string, params: Record<string, unknown> = {}) {
  const gtag = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
  gtag?.('event', event, params);
}

function detectStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function detectIosSafari() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Chrome/Firefox/Edge on iOS and in-app browsers can't add to home screen
  // the same way; only real Safari gets the hint.
  const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|GSA|FBAN|FBAV|Instagram|Telegram|Line\//.test(ua);
  return iOS && !otherBrowser && /Safari/.test(ua);
}

/** Call once on the client (PwaRoot does this). Idempotent. */
export function initPwa() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  setState({ isStandalone: detectStandalone(), isIosSafari: detectIosSafari() });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    setState({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setState({ canInstall: false, isStandalone: true });
    track('pwa_installed');
  });

  if (state.isStandalone) track('pwa_launch');

  if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
    registerServiceWorker();
  }
}

async function registerServiceWorker() {
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });

    const watch = (worker: ServiceWorker | null) => {
      if (!worker) return;
      const check = () => {
        // Only an *update* counts; the first install has no controller yet.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = worker;
          setState({ updateReady: true });
        }
      };
      check();
      worker.addEventListener('statechange', check);
    };

    watch(reg.waiting);
    reg.addEventListener('updatefound', () => watch(reg.installing));

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadOnControllerChange) window.location.reload();
    });

    // Installed apps can stay open for days; look for updates on resume.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  } catch (err) {
    console.warn('[pwa] service worker registration failed', err);
  }
}

export async function promptInstall(placement: string) {
  if (!deferredPrompt) return;
  track('pwa_install_prompt', { placement });
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  track('pwa_install_choice', { placement, outcome });
  deferredPrompt = null;
  setState({ canInstall: false });
}

export function applyUpdate() {
  if (!waitingWorker) return window.location.reload();
  reloadOnControllerChange = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

// "Not now" hides the prompt for two weeks.
const DISMISS_KEY = 'al-install-dismissed-at';
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

export function isInstallDismissed() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

export function dismissInstall(placement: string) {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    // Private mode: the prompt just comes back next visit.
  }
  track('pwa_install_dismissed', { placement });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePwa(): PwaState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}
