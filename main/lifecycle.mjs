// main/lifecycle.mjs — 앱 수명·창·트레이·단축키·ctx 생성. 구조는 WHENWORK main/lifecycle.mjs(34d5f3b)를
// 따르고, 창 둘(메인·퀵캡처)의 크기·동작만 메모용이다(docs/03_기술_스펙 §7).
import { app, BrowserWindow, Tray, Menu, globalShortcut, screen, Notification, protocol, net } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform } from './platform/index.mjs';
import { createQueue } from './queue.mjs';
import { createStore } from './store.mjs';
import { createAttachments, ATTACH_DIR } from './attachments.mjs';
import { createSettings } from './settings.mjs';
import { pickPosition } from './place.mjs';
import { scheduleJobs } from './jobs.mjs';
import { registerIpc, saveCapture } from './ipc.mjs';
import { setupUpdater, updateLine } from './update.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_ID = 'com.when630.whennote';
const MAIN_W = 1120;
const MAIN_H = 720;
const MAIN_MIN_W = 800;
const MAIN_MIN_H = 520;
const CAPTURE_W = 380; // 퀵캡처 — 가로 고정, 세로만 조절(D-05)
const CAPTURE_H = 320;
const CAPTURE_MIN_H = 240;
const CAPTURE_MAX_H = 800;
const SMOKE = process.argv.includes('--smoke');

function argValue(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
const SMOKE_DATA = argValue('--smoke-data=');
const INJECT_CAPTURE = argValue('--inject-capture=');
const CHECK_UPDATE = process.argv.includes('--check-update');

// 첨부 이미지를 화면에 보여주는 스킴(D-11). 렌더러는 file://로 떠 있어 CSP 'self'가 첨부 폴더를
// 가리키지 못하고, file: 전체를 열면 아무 파일이나 읽힌다. 스킴 하나가 첨부 폴더 안의 이름만 낸다.
// registerSchemesAsPrivileged는 ready 전에 딱 한 번만 부를 수 있다 — 모듈 로드 시점에 한다.
const ATTACH_SCHEME = 'wn-attach';
protocol.registerSchemesAsPrivileged([{ scheme: ATTACH_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// 스모크에서 메인 창 렌더러 안에서 돌리는 점검. 검색→열기→보기 전환→닫기를 한 바퀴 돈다.
//
// ※ 이 문자열은 템플릿 리터럴이다 — 안에서 `${...}`를 쓰면 렌더러가 아니라 **여기서** 보간되어
//   ReferenceError로 모듈 초기화가 깨진다(앱이 뜨지 않고 매달린다). 문자열은 +로 잇는다.
const MAIN_PROBE = `(async () => {
  const errors = [];
  window.addEventListener('error', (e) => errors.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('reject: ' + ((e.reason && e.reason.message) || e.reason)));
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { errors.push(name + ': ' + ((e && e.message) || e)); }
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await step('search:all', () => runSearch(''));
  await step('search:term', () => runSearch('없을만한검색어'));
  await step('search:cho', () => runSearch('ㅇㅅㅁ'));
  await step('search:tag', () => runSearch('#없는태그'));
  await step('search:clear', () => runSearch(''));
  await step('archived:on', () => toggleArchived(true));
  await step('archived:off', () => toggleArchived(false));
  await step('settings:open', () => openSettings());
  await step('settings:close', () => closeSettings());
  await step('keymap', () => { toggleKeymap(true); toggleKeymap(false); });
  if (state.results.length) {
    await step('open', () => openNote(state.results[0].id));
    await wait(80);
    await step('preview', () => { togglePreview(); togglePreview(); });
    await step('close', () => closeNote());
  }
  await wait(120);
  return {
    view: !!window.VIEW,
    list: document.getElementById('list') ? 1 : -1,
    titles: state.results.map(function (r) { return r.title; }),
    errors,
  };
})()`;

// 퀵캡처 렌더러 점검. 폭이 380px 고정이라 푸터 안내가 늘면 조용히 잘린다 — 폭을 재 본다.
const CAPTURE_PROBE = `(async () => {
  const errors = [];
  const foot = document.querySelector('.foot');
  if (!foot) errors.push('푸터가 없다');
  else if (foot.scrollWidth > foot.clientWidth + 1) errors.push('푸터가 폭을 넘었다: ' + foot.scrollWidth + ' > ' + foot.clientWidth);
  const ta = document.getElementById('in');
  if (!ta) errors.push('입력창이 없다');
  else {
    ta.value = '스모크 입력';
    ta.dispatchEvent(new Event('input'));
    ta.value = '';
    ta.dispatchEvent(new Event('input'));
  }
  return errors;
})()`;

export function bootstrap() {
  const ctx = {
    tray: null,
    captureWin: null,
    mainWin: null,
    mainHiddenAt: 0,
    quitting: false,
    hotkeyOk: false,
    hotkey: null,
    // 이번 실행에서 즉시 반영에 실패한 캡처 수 — 큐 줄 수가 아니다
    pending: 0,
    // 퀵캡처 항상-위(CAP-06). 켜져 있으면 blur로 닫지 않는다.
    capturePinned: false,
    // 퀵캡처 Ctrl+Enter가 남긴 "메인 창에서 이 메모를 열어라"
    openNoteId: null,
    // 알림이 막혀 화면으로 대신 보여줄 말(PLAT-04 승계)
    pendingNotice: null,
    SMOKE,
  };

  ctx.notify = (title, body, { onClick } = {}) => {
    if (ctx.SMOKE) return true;
    try {
      if (!Notification.isSupported()) throw new Error('unsupported');
      const note = new Notification({ title, body });
      if (onClick) note.on('click', onClick);
      note.show();
      return true;
    } catch {
      ctx.pendingNotice = body ? `${title} — ${body}` : title;
      ctx.notifyChanged?.();
      return false;
    }
  };

  // 스모크는 실사용 인스턴스와 부딪히지 않게 격리한다 — 안 그러면 단일 인스턴스 락에 걸려
  // 아무것도 검증하지 않고 종료 코드 0으로 끝난다.
  if (SMOKE) app.setPath('userData', SMOKE_DATA || path.join(app.getPath('temp'), 'whennote-smoke'));

  // app.quit()은 비동기 종료 요청일 뿐이다 — 여기서 멈춰 트레이·저장소·IPC를 만들지 않는다.
  if (!SMOKE && !app.requestSingleInstanceLock()) {
    app.quit();
    return ctx;
  }

  ctx.queue = createQueue(path.join(app.getPath('userData'), 'queue.jsonl'));
  ctx.settings = createSettings(path.join(app.getPath('userData'), 'settings.json'));
  ctx.store = createStore(path.join(app.getPath('userData'), 'store.sqlite'));
  ctx.attachments = createAttachments(path.join(app.getPath('userData'), ATTACH_DIR));
  registerIpc(ctx);

  // ── 창
  //
  // 프레임리스 창은 resizable을 끄면 Windows가 그리는 그림자·라운드가 함께 사라진다.
  // 크기를 고정하고 싶으면 min=max로 묶는다(WHENWORK에서 확인된 패턴).
  const preload = path.join(__dirname, 'preload.cjs');

  function placeWindow(win, key, { centerY = true } = {}) {
    const [width, height] = win.getSize();
    const { x, y } = pickPosition({
      saved: ctx.settings.get(key),
      size: { width, height },
      workAreas: screen.getAllDisplays().map((d) => d.workArea),
      cursorArea: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
      centerY,
    });
    win.setPosition(x, y);
  }
  ctx.placeWindow = placeWindow;

  function rememberPosition(win, key) {
    const save = () => {
      if (win.isDestroyed() || !win.isVisible()) return;
      const [x, y] = win.getPosition();
      ctx.settings.set(key, { x, y });
    };
    win.on('moved', save);
    win.on('resized', save);
  }

  // ── 퀵캡처 창: 프레임 없음, 항상 위, 세로만 조절
  function getCaptureWin() {
    if (ctx.captureWin && !ctx.captureWin.isDestroyed()) return ctx.captureWin;
    const size = ctx.settings.get('captureSize') ?? {};
    ctx.captureWin = new BrowserWindow({
      width: CAPTURE_W,
      height: size.height ?? CAPTURE_H,
      minWidth: CAPTURE_W,
      maxWidth: CAPTURE_W,
      minHeight: CAPTURE_MIN_H,
      maxHeight: CAPTURE_MAX_H,
      frame: false,
      show: false,
      skipTaskbar: true,
      roundedCorners: true,
      backgroundColor: '#1e2027',
      webPreferences: { preload },
    });
    // 기본 레벨(floating)은 Windows에서 작업 표시줄 뒤로 가라앉는다 — pop-up-menu부터가 그 위다
    ctx.captureWin.setAlwaysOnTop(true, 'pop-up-menu');
    rememberPosition(ctx.captureWin, 'captureBounds');
    ctx.captureWin.on('resized', () => {
      const [, height] = ctx.captureWin.getSize();
      ctx.settings.set('captureSize', { height });
    });
    ctx.captureWin.loadFile(path.join(ROOT, 'renderer', 'capture.html'));
    // 다른 데 클릭하면 저장하고 접는다 — 항상-위가 켜져 있으면 그대로 둔다(CAP-06).
    // 실제 저장은 렌더러가 한다(본문을 렌더러가 갖고 있다): flush를 받으면 save 후 hide를 부른다.
    ctx.captureWin.on('blur', () => {
      if (!ctx.capturePinned && !ctx.quitting) ctx.captureWin.webContents.send('capture:flush');
    });
    ctx.captureWin.on('close', (e) => {
      if (!ctx.quitting) {
        e.preventDefault();
        ctx.captureWin.webContents.send('capture:flush');
      }
    });
    return ctx.captureWin;
  }
  ctx.getCaptureWin = getCaptureWin;

  function showCapture() {
    const win = getCaptureWin();
    placeWindow(win, 'captureBounds', { centerY: false });
    win.webContents.send('capture:reset');
    win.show();
    win.focus();
  }
  ctx.showCapture = showCapture;

  // ── 메인 창: 프레임 없음(제목 표시줄은 렌더러의 드래그 바), 작업 표시줄에 보임,
  // blur로 닫지 않음(편집 중 다른 창을 봐도 남는다). 라운드·그림자는 Windows가 그린다.
  function getMainWin() {
    if (ctx.mainWin && !ctx.mainWin.isDestroyed()) return ctx.mainWin;
    const size = ctx.settings.get('mainSize') ?? {};
    ctx.mainWin = new BrowserWindow({
      width: size.width ?? MAIN_W,
      height: size.height ?? MAIN_H,
      minWidth: MAIN_MIN_W,
      minHeight: MAIN_MIN_H,
      show: false,
      frame: false,
      roundedCorners: true,
      title: 'WHENNOTE',
      backgroundColor: '#16171c',
      autoHideMenuBar: true,
      webPreferences: { preload },
    });
    rememberPosition(ctx.mainWin, 'mainBounds');
    ctx.mainWin.on('resized', () => {
      const [width, height] = ctx.mainWin.getSize();
      ctx.settings.set('mainSize', { width, height });
    });
    ctx.mainWin.loadFile(path.join(ROOT, 'renderer', 'main.html'));
    ctx.mainWin.on('hide', () => {
      ctx.mainHiddenAt = Date.now();
    });
    ctx.mainWin.on('close', (e) => {
      if (!ctx.quitting) {
        e.preventDefault();
        ctx.mainWin.hide();
      }
    });
    return ctx.mainWin;
  }
  ctx.getMainWin = getMainWin;

  // openId가 있으면 그 메모를 열어 보여준다. 창이 아직 로딩 중이면 push가 사라지므로 상태에
  // 실어 두고 렌더러의 첫 app:init이 읽어 간다(WHENWORK의 openTab 교훈).
  function showMain(openId = null) {
    const win = getMainWin();
    if (openId) {
      if (win.webContents.isLoading()) ctx.openNoteId = openId;
      else win.webContents.send('note:open', openId);
    }
    placeWindow(win, 'mainBounds');
    win.show();
    win.focus();
  }
  ctx.showMain = showMain;

  const TOGGLE_GRACE_MS = 400;
  function toggleMain() {
    const win = getMainWin();
    if (win.isVisible() && win.isFocused()) return win.hide();
    if (Date.now() - ctx.mainHiddenAt < TOGGLE_GRACE_MS) return;
    showMain();
  }
  ctx.toggleMain = toggleMain;

  // ── 트레이
  function storeStatusLine() {
    const st = ctx.store.status();
    if (st.notice) return st.notice;
    if (ctx.pending > 0) return `${ctx.pending}건이 기다리고 있어요 — 다시 시작하면 반영됩니다`;
    return '저장소 정상';
  }

  function refreshTrayMenu() {
    if (!ctx.tray) return;
    const st = ctx.store.status();
    const bits = [];
    if (!st.ok) bits.push(st.notice ?? '저장소 대기');
    if (ctx.pending > 0) bits.push(`대기 ${ctx.pending}건`);
    ctx.tray.setToolTip(`WHENNOTE${bits.length ? ' — ' + bits.join(' · ') : ''}`);
    ctx.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '메모 열기', click: () => showMain() },
        {
          label: ctx.hotkeyOk
            ? `퀵 메모 (${platform.hotkeyLabel(ctx.hotkey)})`
            : '퀵 메모 — 단축키 등록 실패! (설정에서 다른 조합으로)',
          click: showCapture,
        },
        { type: 'separator' },
        { label: storeStatusLine(), enabled: false },
        { type: 'separator' },
        {
          label: '로그인 시 자동 시작',
          type: 'checkbox',
          checked: platform.getLoginItem(app),
          click: (menuItem) => {
            const ok = platform.setLoginItem(app, menuItem.checked);
            if (ok) ctx.settings.set('openAtLogin', menuItem.checked);
            else ctx.notify('자동 시작을 켜지 못했습니다', '시스템 설정의 로그인 항목에서 직접 추가해 주세요');
            refreshTrayMenu();
          },
        },
        {
          label: '창 위치 초기화',
          click: () => {
            for (const key of ['captureBounds', 'captureSize', 'mainBounds', 'mainSize']) ctx.settings.remove(key);
            if (ctx.mainWin && !ctx.mainWin.isDestroyed()) {
              ctx.mainWin.setSize(MAIN_W, MAIN_H);
              if (ctx.mainWin.isVisible()) placeWindow(ctx.mainWin, 'mainBounds');
            }
            if (ctx.captureWin && !ctx.captureWin.isDestroyed()) {
              ctx.captureWin.setSize(CAPTURE_W, CAPTURE_H);
              if (ctx.captureWin.isVisible()) placeWindow(ctx.captureWin, 'captureBounds', { centerY: false });
            }
          },
        },
        { type: 'separator' },
        {
          label: updateLine(ctx.update ?? {}, { canAutoUpdate: platform.canAutoUpdate, current: app.getVersion() }),
          enabled: ctx.update?.status === 'ready' || ctx.update?.status === 'available',
          click: () => ctx.installUpdate?.(),
        },
        { type: 'separator' },
        { label: '종료', click: () => app.quit() },
      ])
    );
  }
  ctx.refreshTrayMenu = refreshTrayMenu;

  // ── 앱 수명
  platform.prepareApp(app, { appId: APP_ID });
  // 개발 실행과 설치본이 같은 userData(큐·설정·저장소)를 쓰도록 이름을 고정한다.
  // WHENWORK('whenwork')와 다른 폴더라 두 앱이 같은 PC에서 서로 간섭하지 않는다(PLAT-06).
  app.setName('whennote');

  app.whenReady().then(async () => {
    // wn-attach://files/<이름> → attachments/<이름>. 이름 규칙(UUID.확장자)에 맞지 않거나 폴더 밖이면 400.
    protocol.handle(ATTACH_SCHEME, (req) => {
      let name = '';
      try {
        name = path.basename(decodeURIComponent(new URL(req.url).pathname));
      } catch {
        name = '';
      }
      const full = ctx.attachments.resolve(name);
      if (!full) return new Response('bad', { status: 400 });
      return net.fetch(pathToFileURL(full).toString());
    });

    ctx.tray = new Tray(platform.trayImage(ROOT));
    ctx.tray.on('click', toggleMain);
    // 단축키는 퀵캡처 토글 — 열려 있으면 저장하고 닫고, 없으면 연다
    const onHotkey = () => {
      if (ctx.captureWin && !ctx.captureWin.isDestroyed() && ctx.captureWin.isVisible()) {
        return ctx.captureWin.webContents.send('capture:flush');
      }
      showCapture();
    };
    ctx.applyHotkey = (accel) => {
      globalShortcut.unregisterAll();
      const next = accel || ctx.settings.get('hotkey') || platform.defaultHotkey;
      let ok = false;
      try {
        ok = globalShortcut.register(next, onHotkey) && globalShortcut.isRegistered(next);
      } catch {
        ok = false;
      }
      ctx.hotkey = next;
      ctx.hotkeyOk = ok;
      refreshTrayMenu();
      return ok;
    };
    ctx.applyHotkey();
    if (!ctx.hotkeyOk) {
      ctx.notify('단축키를 등록하지 못했습니다', `${platform.hotkeyLabel(ctx.hotkey)} 를 다른 앱이 쓰고 있습니다 — 설정에서 다른 조합으로 바꿔 주세요`);
    }
    setupUpdater(ctx);
    if (CHECK_UPDATE) {
      const st = await ctx.checkForUpdate();
      console.log(
        `UPDATE_CHECK status=${st.status} version=${st.version ?? '-'} canAutoUpdate=${platform.canAutoUpdate} line=${updateLine(st, { canAutoUpdate: platform.canAutoUpdate, current: app.getVersion() })}`
      );
      if (st.rawError) console.log(`UPDATE_RAW ${st.rawError}`);
      ctx.quitting = true;
      return app.exit(st.status === 'error' ? 1 : 0);
    }
    scheduleJobs(ctx);

    if (app.isPackaged && ctx.settings.get('openAtLogin') !== false) {
      platform.setLoginItem(app, true);
    }

    // PLAT-04: 첫 실행 한 번만. 알림이 막혀 있으면 메인 창을 열어 같은 말을 화면으로 보여준다.
    if (!SMOKE && !ctx.settings.get('firstRunShown')) {
      const hint = platform.firstRunHint(platform.hotkeyLabel(ctx.hotkey));
      ctx.settings.set('firstRunShown', true);
      if (!ctx.notify(hint.title, hint.body)) {
        ctx.pendingNotice = `${hint.title} — ${hint.body}`;
        showMain();
      }
    }

    if (SMOKE && INJECT_CAPTURE) {
      // 강제종료 스모크의 주입 모드 — 진짜 캡처 경로(saveCapture)로 한 건을 저장하고 스스로
      // 종료하지 않는다. 밖에서 SIGKILL로 죽이는 것이 요점이다.
      const res = saveCapture(ctx, INJECT_CAPTURE);
      console.log(`CAPTURE_INJECTED ${res.id}`);
    } else if (SMOKE) {
      const win = getMainWin();
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          let probe = null;
          try {
            probe = await win.webContents.executeJavaScript(MAIN_PROBE);
          } catch (err) {
            probe = { errors: [String(err?.message ?? err)] };
          }
          let capture = null;
          try {
            const cap = getCaptureWin();
            if (cap.webContents.isLoading()) {
              await new Promise((r) => cap.webContents.once('did-finish-load', r));
            }
            capture = await cap.webContents.executeJavaScript(CAPTURE_PROBE);
          } catch (err) {
            capture = [String(err?.message ?? err)];
          }
          const ok = probe?.view === true && probe?.list > 0 && probe?.errors?.length === 0 && capture?.length === 0;
          console.log(
            `SMOKE_${ok ? 'OK' : 'FAIL'} hotkey=${ctx.hotkeyOk} notes=${ctx.store.count()} renderer=${JSON.stringify(probe)} capture=${JSON.stringify(capture)}`
          );
          ctx.quitting = true;
          app.exit(ok ? 0 : 1);
        }, 1200);
      });
    }
  });

  app.on('before-quit', () => {
    ctx.quitting = true;
    ctx.settings.flush();
    ctx.store.close(); // wal_checkpoint(TRUNCATE) 후 닫는다 — store.sqlite 하나만 복사해도 온전해야 한다
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
  app.on('window-all-closed', () => {});

  return ctx;
}
