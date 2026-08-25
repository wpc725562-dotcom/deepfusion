// index.js — dshtunnel 统一出口（内嵌 DeepFusion 与独立 CLI 共用）
export { createTunnelService } from './service.js';
export { createPocketProxy } from './proxy.js';
export { startQuickTunnel, startCustomTunnel, resolveCloudflared, QUICK_TUNNEL_URL_RE } from './tunnel.js';
export { qrDataUrl, qrTerminal } from './qr.js';
export * from './settings.js';
export * from './pin.js';
export * as settings from './settings.js';
export * as pin from './pin.js';
export const DEFAULT_PORT = 3082;