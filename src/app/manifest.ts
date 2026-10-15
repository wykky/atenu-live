/**
 * Web App Manifest at /manifest.webmanifest.
 *
 * start_url opens the PIN screen because students are almost all installs;
 * teachers get a "Host a game" shortcut (long-press the icon on Android).
 * `?source=pwa` lets analytics tell home-screen launches from browser visits.
 *
 * No `orientation` lock: hosts run the game on landscape laptops and
 * projectors, and a portrait lock would rotate their screen.
 *
 * Icons are static PNGs in public/pwa/ built by scripts/pwa-icons/build.py. Screenshots in
 * public/screenshots/ enable Chrome's richer install sheet.
 */

import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Atenu Live',
    short_name: 'Atenu Live',
    description:
      'Real-time multiplayer quiz games for Ethiopian high-school students. Join with a PIN, no account needed.',
    start_url: '/join?source=pwa',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: '#FFC600',
    theme_color: '#FFC600',
    categories: ['education', 'games'],
    lang: 'en',
    dir: 'ltr',
    prefer_related_applications: false,
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      {
        name: 'Join a game',
        short_name: 'Join',
        description: 'Enter a game PIN',
        url: '/join?source=pwa-shortcut',
        icons: [{ src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
      {
        name: 'Host a game',
        short_name: 'Host',
        description: 'Start a live quiz for your class',
        url: '/host?source=pwa-shortcut',
        icons: [{ src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
      {
        name: 'Quiz library',
        short_name: 'Library',
        description: 'Ready-made quizzes by subject',
        url: '/library?source=pwa-shortcut',
        icons: [{ src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ],
    screenshots: [
      {
        src: '/screenshots/join-narrow.png',
        sizes: '780x1688',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'Join a live quiz with the PIN your teacher shares',
      },
      {
        src: '/screenshots/home-wide.png',
        sizes: '1440x900',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Host or join real-time quiz games',
      },
    ],
  };
}
