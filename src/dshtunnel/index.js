// dshtunnel 内嵌出口 — 复用 packages/dshtunnel/lib 作为单一实现源
// 内嵌 DeepFusion 时 Electron 打包需包含 packages/dshtunnel/lib
export * from '../../packages/dshtunnel/lib/index.js';
