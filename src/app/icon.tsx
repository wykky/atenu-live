/**
 * 192x192 favicon PNG generated at build time. favicon.ico in this folder
 * stays the legacy fallback for very old browsers. Artwork is shared with
 * the PWA icons in src/lib/brand-icon.tsx.
 */

import { renderBrandIcon } from '@/lib/brand-icon';

export const size = { width: 192, height: 192 };
export const contentType = 'image/png';

export default function Icon() {
  return renderBrandIcon({ size: 192, framed: true });
}
