// main/deeplink.mjs — 형제 앱 연동의 순수 부분(D-13). 규약은 when630/when-protocol.
//
//   parseDeepLink   whennote://search?q=회의 → { command: 'search', args: { q: '회의' } }. 모르는 스킴·명령은 null
//   fromArgv        Windows/Linux는 URL이 argv로 온다(첫 실행이면 process.argv, 떠 있으면 second-instance)
//   buildManifest   ~/.when/apps/whennote.json에 쓸 명령 목록 — WHENCOMMAND가 읽어 입력줄에 합친다

export const SCHEME = 'whennote';
export const APP_ID = 'whennote';

// 이 앱이 받는 명령. title은 WHENCOMMAND 입력줄에 보이는 이름이고, 그 뒤에 띄어 쓴 것이 첫 인자로 온다(when-protocol D-22).
export const COMMANDS = [
  { id: 'capture', title: '퀵 메모', description: '작은 메모 창 — 적고 Esc로 저장', args: [{ name: 'text', type: 'string', optional: true }] },
  { id: 'search', title: '메모 검색', description: '메모 창을 열고 검색어를 넣는다', args: [{ name: 'q', type: 'string' }] },
  { id: 'new', title: '새 메모', description: '적은 글로 메모를 만들고 메모 창에서 연다', args: [{ name: 'text', type: 'string', optional: true }] },
  { id: 'open', title: '메모 창 열기' },
];

const KNOWN = new Set(COMMANDS.map((c) => c.id));

export function parseDeepLink(raw) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { return null; }
  if (u.protocol !== `${SCHEME}:`) return null;
  // whennote://search?q=x 는 host가 'search'. whennote:search 처럼 //가 빠진 꼴은 pathname에 온다 — 둘 다 받는다
  const command = (u.host || u.pathname.replace(/^\/+/, '')).replace(/\/+$/, '').toLowerCase();
  if (!KNOWN.has(command)) return null;
  const args = {};
  for (const [k, v] of u.searchParams) if (v) args[k] = v;
  return { command, args };
}

export function fromArgv(argv) {
  return (argv ?? []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${SCHEME}://`)) ?? null;
}

// verify는 실제로 설치돼 있는지 WHENCOMMAND가 확인하는 경로다. 패키징본이면 지금 실행 파일(macOS는 .app 번들),
// 개발 실행이면 설치본의 관례 경로 — 개발용 electron.exe를 적으면 설치본이 없는 PC에서도 "있다"고 읽힌다.
export function buildManifest({ platformName, exePath, packaged }) {
  const verify = {
    darwin: '/Applications/WHENNOTE.app',
    win32: '%LOCALAPPDATA%\\Programs\\WHENNOTE\\WHENNOTE.exe',
  };
  if (packaged && exePath) {
    if (platformName === 'darwin') {
      const m = String(exePath).match(/^(.*?\.app)\//);
      if (m) verify.darwin = m[1];
    } else if (platformName === 'win32') {
      verify.win32 = exePath;
    }
  }
  return {
    protocol: 1,
    id: APP_ID,
    name: 'WHENNOTE',
    scheme: SCHEME,
    verify,
    commands: COMMANDS.map((c) => ({ ...c, args: c.args ? c.args.map((a) => ({ ...a })) : undefined })),
  };
}
