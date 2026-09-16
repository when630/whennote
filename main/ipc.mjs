// main/ipc.mjs — 모든 ipcMain 핸들러. 채널 목록은 docs/03_기술_스펙.md §6.
import { app, BrowserWindow, ipcMain } from 'electron';
import crypto from 'node:crypto';
import { platform } from './platform/index.mjs';
import { updateLine } from './update.mjs';

// 캡처 저장의 단일 경로(WHENWORK D-01/D-03 승계). capture:save·note:create·강제종료 스모크의
// 주입 모드가 모두 이 함수를 부른다 — 경로가 하나여야 테스트가 실경로를 밟는다.
//
// 순서 자체가 계약이다:
// 1) 본문을 다듬는다(줄바꿈 정규화, 끝 공백 제거). 비어 있으면 { ok: false }.
// 2) queue.append — 동기, fs만 의존. 여기까지 오면 메모는 이미 보존된 것이다.
// 3) store.insertCaptures를 동기로 즉시 시도한다.
// 4) 던지면 store.reopen() 후 한 번 더.
// 5) 그래도 던지면 ctx.pending += 1. 예외를 위로 올리지 않는다.
export function saveCapture(ctx, body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').trimEnd();
  if (!text.trim()) return { ok: false };
  const entry = { id: crypto.randomUUID(), body: text, captured_at: new Date().toISOString() };
  ctx.queue.append(entry);
  try {
    ctx.store.insertCaptures([entry]);
  } catch {
    try {
      ctx.store.reopen();
      ctx.store.insertCaptures([entry]);
    } catch {
      ctx.pending += 1;
    }
  }
  ctx.refreshTrayMenu();
  ctx.notifyChanged();
  return { ok: true, pending: ctx.pending, id: entry.id };
}

export function registerIpc(ctx) {
  // 저장소가 바뀌었으니 다시 그려라 — 퀵캡처 저장이 메인 창 목록에 바로 보이게
  ctx.notifyChanged = () => {
    if (ctx.mainWin && !ctx.mainWin.isDestroyed()) ctx.mainWin.webContents.send('state:changed');
  };

  // 저장소 호출을 { ok } 봉투로 감싼다 — 렌더러에 처리되지 않은 프로미스 거부를 남기지 않는다.
  function guarded(fn) {
    return (_e, ...args) => {
      try {
        const out = fn(...args);
        return out && typeof out === 'object' && !Array.isArray(out) ? { ok: true, ...out } : { ok: true, value: out };
      } catch {
        return { ok: false };
      }
    };
  }

  // ── 퀵캡처
  ipcMain.handle('capture:save', (_e, body) => saveCapture(ctx, body));

  ipcMain.handle('capture:pin', (_e, on) => {
    ctx.capturePinned = !!on;
    return { ok: true, pinned: ctx.capturePinned };
  });

  // 저장하고 메인 창에서 이어서 편집(CAP-02). 저장이 안 되는 빈 본문이면 창만 연다.
  ipcMain.handle('capture:openInMain', (e, body) => {
    const res = saveCapture(ctx, body);
    BrowserWindow.fromWebContents(e.sender)?.hide();
    ctx.showMain(res.ok ? res.id : null);
    return res;
  });

  // ── 메모
  ipcMain.handle('note:search', guarded((q, opts) => ctx.store.searchNotes({ q, ...(opts ?? {}) })));

  ipcMain.handle('note:get', guarded((id) => {
    ctx.store.touchOpened(id);
    const note = ctx.store.getNote(id);
    return { note };
  }));

  ipcMain.handle('note:update', guarded((id, body) => {
    const res = ctx.store.updateNote(id, body);
    return res ?? { missing: true };
  }));

  ipcMain.handle('note:create', (_e, body) => saveCapture(ctx, body));

  const flagOps = {
    'note:pin': (id, on) => ctx.store.setPinned(id, on),
    'note:archive': (id, on) => ctx.store.setArchived(id, on),
    'note:remove': (id) => ctx.store.removeNote(id),
    'note:restore': (id) => ctx.store.restoreNote(id),
    'note:move': (id, dir) => ctx.store.movePinned(id, dir),
  };
  for (const [ch, fn] of Object.entries(flagOps)) {
    ipcMain.handle(ch, guarded((...args) => ({ changed: fn(...args) })));
  }

  ipcMain.handle('tag:list', guarded(() => ({ tags: ctx.store.listTags() })));

  // ── 창이 처음 뜰 때 필요한 것과 설정 화면이 보는 것
  ipcMain.handle('app:init', () => {
    const st = ctx.store.status();
    // 퀵캡처 Ctrl+Enter가 남긴 "이 메모를 열어라". 한 번 읽어 가면 비운다.
    const openNoteId = ctx.openNoteId ?? null;
    ctx.openNoteId = null;
    const notice = ctx.pendingNotice;
    ctx.pendingNotice = null;
    return {
      ok: true,
      openNoteId,
      notice,
      pending: ctx.pending,
      hotkey: ctx.hotkey ?? platform.defaultHotkey,
      hotkeyLabel: platform.hotkeyLabel(ctx.hotkey ?? platform.defaultHotkey),
      hotkeyOk: ctx.hotkeyOk,
      platform: platform.name,
      store: { file: ctx.store.file, ok: st.ok, notice: st.notice },
      version: app.getVersion(),
      update: {
        ...(ctx.update ?? { status: 'idle' }),
        line: updateLine(ctx.update ?? {}, { canAutoUpdate: platform.canAutoUpdate, current: app.getVersion() }),
        canAutoUpdate: platform.canAutoUpdate,
      },
    };
  });

  // PLAT-02: 조합을 바꾸면 그 조합의 등록 성공 여부까지 확인해서 돌려준다.
  ipcMain.handle('hotkey:set', (_e, accel) => {
    const next = String(accel ?? '').trim();
    if (!next) return { ok: false, error: '조합이 비어 있습니다' };
    const prev = ctx.hotkey;
    if (ctx.applyHotkey(next)) {
      ctx.settings.set('hotkey', next);
      ctx.settings.flush();
      return { ok: true, hotkey: next, label: platform.hotkeyLabel(next) };
    }
    ctx.applyHotkey(prev);
    return { ok: false, error: '그 조합은 다른 앱이 쓰고 있거나 잘못된 형식입니다' };
  });

  // ── 업데이트
  ipcMain.handle('update:check', async () => {
    const st = await (ctx.checkForUpdate?.() ?? Promise.resolve(ctx.update));
    return { ok: true, ...st, line: updateLine(st ?? {}, { canAutoUpdate: platform.canAutoUpdate, current: app.getVersion() }) };
  });
  ipcMain.handle('update:install', () => ({ ok: true, installing: !!ctx.installUpdate?.() }));

  // ── 공통
  ipcMain.on('win:hide', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.hide();
  });
  ipcMain.on('win:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });
  ipcMain.on('app:open', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.hide();
    ctx.showMain(null);
  });
}
