/**
 * 180x180 apple-touch-icon. Next auto-injects
 * <link rel="apple-touch-icon" sizes="180x180" /> when this file is present.
 * Unframed, solid yellow: iOS masks the corners itself and dislikes
 * transparency. Artwork is shared via src/lib/brand-icon.tsx.
 */

import { renderBrandIcon } from '@/lib/brand-icon';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return renderBrandIcon({ size: 180 });
}
