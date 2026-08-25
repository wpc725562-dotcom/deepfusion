// qr.js — 二维码生成（零网络依赖，本地渲染）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

export async function qrDataUrl(text, { width = 220, margin = 1 } = {}) {
  return QRCode.toDataURL(String(text), { errorCorrectionLevel: 'M', margin, width, type: 'image/png' });
}

export async function qrTerminal(text) {
  return QRCode.toString(String(text), { errorCorrectionLevel: 'M', type: 'terminal', small: true });
}
