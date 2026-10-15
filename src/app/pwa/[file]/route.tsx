/**
 * PWA icon set, rendered once at build time (force-static).
 *
 *   /pwa/icon-192.png      purpose "any"      (launcher, install dialog)
 *   /pwa/icon-512.png      purpose "any"      (splash screen)
 *   /pwa/maskable-512.png  purpose "maskable" (Android adaptive icon)
 *
 * The maskable variant is full-bleed yellow with the mark inside the central
 * 80% safe zone, so Android can crop it to a circle, squircle or teardrop
 * without clipping the letters. Artwork lives in src/lib/brand-icon.tsx.
 */

import { renderBrandIcon } from '@/lib/brand-icon';

export const dynamic = 'force-static';

const ICONS = {
  'icon-192.png': { size: 192, maskable: false },
  'icon-512.png': { size: 512, maskable: false },
  'maskable-512.png': { size: 512, maskable: true },
} as const;

export function generateStaticParams() {
  return Object.keys(ICONS).map((file) => ({ file }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const spec = ICONS[file as keyof typeof ICONS];
  if (!spec) return new Response('Not found', { status: 404 });

  return renderBrandIcon({
    size: spec.size,
    maskable: spec.maskable,
    framed: !spec.maskable,
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}
