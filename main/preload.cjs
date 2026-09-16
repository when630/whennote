// 샌드박스 preload — ESM을 쓸 수 없으므로 CJS로 둔다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whennote', {
  // ── 퀵캡처
  save: (body) => ipcRenderer.invoke('capture:save', body),
  pin: (on) => ipcRenderer.invoke('capture:pin', on),
  openInMain: (body) => ipcRenderer.invoke('capture:openInMain', body),
  onReset: (cb) => ipcRenderer.on('capture:reset', () => cb()),
  clipboardPeek: () => ipcRenderer.invoke('capture:clipboard'),
  // 메인 프로세스가 "저장하고 닫아라"를 시킬 때(blur, 창 닫기)
  onFlush: (cb) => ipcRenderer.on('capture:flush', () => cb()),

  // ── 메인 창
  init: () => ipcRenderer.invoke('app:init'),
  search: (q, opts) => ipcRenderer.invoke('note:search', q, opts),
  get: (id) => ipcRenderer.invoke('note:get', id),
  update: (id, body) => ipcRenderer.invoke('note:update', id, body),
  create: (body) => ipcRenderer.invoke('note:create', body),
  setPinned: (id, on) => ipcRenderer.invoke('note:pin', id, on),
  setArchived: (id, on) => ipcRenderer.invoke('note:archive', id, on),
  remove: (id) => ipcRenderer.invoke('note:remove', id),
  restore: (id) => ipcRenderer.invoke('note:restore', id),
  // 고정 그룹 안에서 한 칸 위(-1)/아래(1)
  move: (id, dir) => ipcRenderer.invoke('note:move', id, dir),
  tags: () => ipcRenderer.invoke('tag:list'),
  // 붙여넣은 이미지 → 파일 저장 → 본문에 넣을 마크다운
  attach: (id, image) => ipcRenderer.invoke('note:attach', id, image),
  dataExport: () => ipcRenderer.invoke('data:export'),
  dataImport: () => ipcRenderer.invoke('data:import'),
  dataExportMarkdown: () => ipcRenderer.invoke('data:exportMarkdown'),
  onChanged: (cb) => ipcRenderer.on('state:changed', () => cb()),
  onOpenNote: (cb) => ipcRenderer.on('note:open', (_e, id) => cb(id)),

  // ── 설정·업데이트
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsAutostart: (on) => ipcRenderer.invoke('settings:autostart', on),
  settingsOpenData: () => ipcRenderer.invoke('settings:openData'),
  hotkeySet: (accel) => ipcRenderer.invoke('hotkey:set', accel),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),

  // ── 공통
  hide: () => ipcRenderer.send('win:hide'),
  minimize: () => ipcRenderer.send('win:minimize'),
  openApp: () => ipcRenderer.send('app:open'),
});
