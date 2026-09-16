// main/ipc.mjs — 모든 ipcMain 핸들러. 채널 목록은 docs/03_기술_스펙.md §6.
import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { platform } from './platform/index.mjs';
import { updateLine } from './update.mjs';
import * as clip from './clipboard.mjs';
import { extensionFor } from './clipboard.mjs';
import { validateExport, safeFilename, noteToMarkdown, referencedAttachments } from './export.mjs';
import { ATTACH_DIR, sniffImageExt } from './attachments.mjs';

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

  // CAP-07: 퀵캡처가 열릴 때 클립보드에 뭐가 있는지 한 줄. 붙이는 건 사용자의 Ctrl+V다.
  ipcMain.handle('capture:clipboard', async () => {
    try {
      return { ok: true, peek: await clip.peek() };
    } catch {
      return { ok: true, peek: null };
    }
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

  // touch: false — 화살표로 훑어보는 것은 "열어봤다"로 치지 않는다. 치면 최근 열어본 순 목록이
  // 훑는 동안 계속 뒤바뀐다. Enter·클릭·편집만 opened_at을 올린다.
  ipcMain.handle('note:get', guarded((id, opts) => {
    if (opts?.touch !== false) ctx.store.touchOpened(id);
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

  // MAIN-08: 렌더러가 붙여넣기에서 잡은 이미지 바이트를 파일로 저장하고 본문에 넣을 마크다운을 돌려준다.
  // 파일만 저장한다 — 어느 메모의 것인지는 본문이 저장될 때 `attachments/<이름>` 참조를 읽어 묶는다
  // (store.insertCaptures·updateNote). 그래서 아직 id가 없는 퀵캡처 창에서도 붙일 수 있다(D-11 개정).
  // 저장되지 않은 채 버려진 파일은 하루 뒤 고아 정리가 치운다. 10MB를 넘으면 저장은 하되 large로 알린다(D-08).
  ipcMain.handle('note:attach', (_e, _noteId, { type, bytes } = {}) => {
    try {
      let buf = toBuffer(bytes);
      if (!buf || !buf.length) return { ok: false, error: '이미지 자료가 비어 있습니다' };
      // 형식은 내용으로 판별한다 — 클립보드의 MIME(image/x-png, 빈 값 등)은 믿을 게 못 된다.
      // 그래도 모르는 형식이면 Electron이 디코딩할 수 있는지 보고, 되면 PNG로 저장한다.
      let ext = sniffImageExt(buf) ?? extensionFor(type);
      if (!ext) {
        const img = nativeImage.createFromBuffer(buf);
        if (img.isEmpty()) return { ok: false, error: `지원하지 않는 이미지 형식입니다 (${type || '형식 정보 없음'})` };
        buf = img.toPNG();
        ext = 'png';
      }
      const saved = ctx.attachments.save(buf, ext);
      return { ok: true, file: saved.file, large: saved.large, markdown: `![이미지](${ATTACH_DIR}/${saved.file})` };
    } catch {
      return { ok: false, error: '이미지를 저장하지 못했습니다' };
    }
  });

  // IPC를 건너온 바이트는 ArrayBuffer·Uint8Array·Buffer 어느 것으로도 올 수 있다
  function toBuffer(bytes) {
    if (!bytes) return null;
    if (Buffer.isBuffer(bytes)) return bytes;
    if (bytes instanceof ArrayBuffer) return Buffer.from(new Uint8Array(bytes));
    if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes?.type === 'Buffer' && Array.isArray(bytes.data)) return Buffer.from(bytes.data);
    return null;
  }

  // ── 내보내기·가져오기 (DATA-01~03). 대화상자 기본 위치는 Electron 43부터 다운로드 폴더다.
  const stamp = () => new Date().toISOString().slice(0, 10);

  ipcMain.handle('data:export', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    try {
      const res = await dialog.showSaveDialog(win, {
        title: '데이터 내보내기',
        defaultPath: `whennote-${stamp()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      const data = ctx.store.exportAll();
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
      const images = ctx.attachments.copyTo(data.attachment.map((a) => a.file), path.dirname(res.filePath));
      return { ok: true, note: data.note.length, images };
    } catch {
      return { ok: false, error: '내보내기에 실패했습니다' };
    } finally {
      win?.focus();
    }
  });

  ipcMain.handle('data:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    try {
      const res = await dialog.showOpenDialog(win, {
        title: '데이터 가져오기 — 지금 데이터는 이 파일의 내용으로 바뀝니다',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      } catch {
        return { ok: false, error: '읽을 수 없는 파일입니다' };
      }
      const bad = validateExport(parsed, ctx.store.schemaVersion());
      if (bad) return { ok: false, error: bad };
      const out = ctx.store.importAll(parsed);
      const images = ctx.attachments.importFrom(path.dirname(res.filePaths[0]));
      ctx.notifyChanged();
      ctx.refreshTrayMenu();
      return { ok: true, ...out, images };
    } catch {
      return { ok: false, error: '가져오기에 실패했습니다' };
    } finally {
      win?.focus();
    }
  });

  // 메모 하나 = .md 하나, 태그는 frontmatter. 읽기 전용 내보내기(DATA-03).
  ipcMain.handle('data:exportMarkdown', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    try {
      const res = await dialog.showOpenDialog(win, {
        title: '마크다운으로 내보낼 폴더 — 메모 하나가 파일 하나가 됩니다',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
      const dir = res.filePaths[0];
      const notes = ctx.store.allNotes();
      const files = new Set();
      for (const n of notes) {
        fs.writeFileSync(path.join(dir, safeFilename(n.title, n.id)), noteToMarkdown(n, n.tags), 'utf8');
        for (const f of referencedAttachments(n.body)) files.add(f);
      }
      const images = ctx.attachments.copyTo([...files], dir);
      return { ok: true, note: notes.length, images };
    } catch {
      return { ok: false, error: '내보내기에 실패했습니다' };
    } finally {
      win?.focus();
    }
  });

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

  // ── 설정 화면. app:init과 달리 읽어도 상태(openNoteId·notice)를 비우지 않는다.
  function settingsView() {
    const st = ctx.store.status();
    const hotkey = ctx.hotkey ?? platform.defaultHotkey;
    return {
      ok: true,
      hotkey,
      hotkeyLabel: platform.hotkeyLabel(hotkey),
      hotkeyDefault: platform.defaultHotkey,
      hotkeyOk: ctx.hotkeyOk,
      openAtLogin: platform.getLoginItem(app),
      packaged: app.isPackaged,
      platform: platform.name,
      store: { file: ctx.store.file, ok: st.ok, notice: st.notice, notes: ctx.store.count() },
      version: app.getVersion(),
      update: {
        ...(ctx.update ?? { status: 'idle' }),
        line: updateLine(ctx.update ?? {}, { canAutoUpdate: platform.canAutoUpdate, current: app.getVersion() }),
        canAutoUpdate: platform.canAutoUpdate,
      },
    };
  }
  ipcMain.handle('settings:get', () => settingsView());

  // PLAT-03: 미서명 macOS에서는 켜지지 않을 수 있다 — 돌려받은 값으로 확인하고, 실패하면
  // 설정에 저장하지 않는다(다음에 켜졌다고 거짓으로 보이지 않게).
  ipcMain.handle('settings:autostart', (_e, on) => {
    const ok = platform.setLoginItem(app, !!on);
    if (ok) {
      ctx.settings.set('openAtLogin', !!on);
      ctx.settings.flush();
    }
    ctx.refreshTrayMenu();
    return { ok, openAtLogin: platform.getLoginItem(app) };
  });

  // 데이터 파일이 있는 폴더를 연다 — 사용자 자신의 파일이라 위치를 감출 이유가 없다
  ipcMain.handle('settings:openData', () => {
    shell.showItemInFolder(ctx.store.file);
    return { ok: true };
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
  // 본문의 외부 링크. http·https만 — file:이나 다른 스킴은 열지 않는다(본문은 사용자가 적은 글이지만
  // 가져온 JSON이나 붙인 글에서 온 링크일 수 있다).
  ipcMain.handle('shell:open', async (_e, url) => {
    try {
      const u = new URL(String(url ?? ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false };
      await shell.openExternal(u.toString());
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

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
