import jsQR from 'jsqr';
import type { Box } from '../types';

export interface QrHit {
  box: Box;
  data: string;
}

/**
 * QR codes are a genuine leak vector in screen recordings: wifi credentials,
 * 2FA enrolment codes and payment links all travel as QR. They're also cheap to
 * find, so we scan every analysed frame.
 */
export function detectQr(image: ImageData): QrHit[] {
  try {
    const res = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    if (!res?.location) return [];
    const pts = [
      res.location.topLeftCorner,
      res.location.topRightCorner,
      res.location.bottomLeftCorner,
      res.location.bottomRightCorner,
    ];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    if (w < 12 || h < 12) return [];
    const pad = Math.max(w, h) * 0.08;
    return [
      {
        box: { x: Math.max(0, x - pad), y: Math.max(0, y - pad), w: w + pad * 2, h: h + pad * 2 },
        data: res.data ?? '',
      },
    ];
  } catch {
    return [];
  }
}
