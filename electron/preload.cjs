/**
 * preload.js — 预加载脚本（暴露安全 API 给渲染进程）
 * 参考：DSH 的 preload + contextBridge
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('deepfusion', {
  isElectron: true,
  version: process.env.npm_package_version || '0.1.0'
});
