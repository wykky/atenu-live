/**
 * Shared "AL" app-icon renderer for favicon, apple-touch-icon and the PWA set.
 *
 * ImageResponse (Satori) only ships a regular-weight default font, which made
 * the old icons render a thin "AL". We load Galindo, the same face as the
 * "Atenu Live" wordmark, subset to just the two glyphs. Without a User-Agent
 * Google Fonts serves TTF, which Satori can read (it cannot read WOFF2).
 * Runs at build time only (all icon routes are static).
 */

import { ImageResponse } from 'next/og';

let fontPromise: Promise<ArrayBuffer | null> | null = null;

function loadGalindo() {
  fontPromise ??= (async () => {
    try {
      const css = await fetch('https://fonts.googleapis.com/css2?family=Galindo&text=AL').then((r) => r.text());
      const url = /src:\s*url\(([^)]+)\)/.exec(css)?.[1];
      if (!url) return null;
      return await fetch(url).then((r) => r.arrayBuffer());
    } catch {
      return null; // Offline build: fall back to the default font.
    }
  })();
  return fontPromise;
}

interface BrandIconOptions {
  size: number;
  /** Full-bleed, mark inside the 80% safe zone, no border (Android adaptive icons). */
  maskable?: boolean;
  /** Black frame + rounded corners (favicon / "any" icons). */
  framed?: boolean;
  headers?: Record<string, string>;
}

export async function renderBrandIcon({ size, maskable = false, framed = false, headers }: BrandIconOptions) {
  const font = await loadGalindo();
  const fontSize = Math.round(size * (maskable ? 0.46 : 0.6));
  const border = framed ? Math.round(size * 0.0625) : 0;
  const radius = framed ? Math.round(size * 0.17) : 0;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FFC600',
          color: '#000',
          fontSize,
          fontFamily: font ? 'Galindo' : 'system-ui',
          // Galindo's caps sit high; nudge down to look optically centred.
          paddingTop: Math.round(size * 0.04),
          // Satori chokes on `border: undefined`, so add the key only when used.
          ...(border ? { border: `${border}px solid #000` } : {}),
          borderRadius: radius,
          boxSizing: 'border-box',
        }}
      >
        AL
      </div>
    ),
    {
      width: size,
      height: size,
      fonts: font ? [{ name: 'Galindo', data: font, weight: 400, style: 'normal' }] : undefined,
      headers,
    }
  );
}
