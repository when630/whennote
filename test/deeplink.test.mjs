import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLink, fromArgv, buildManifest, COMMANDS } from '../main/deeplink.mjs';

test('딥링크: whennote://<명령>?<인자> 를 푼다, 값은 URL 디코딩', () => {
  assert.deepEqual(parseDeepLink('whennote://search?q=%ED%9A%8C%EC%9D%98'), { command: 'search', args: { q: '회의' } });
  assert.deepEqual(parseDeepLink('whennote://open'), { command: 'open', args: {} });
  assert.deepEqual(parseDeepLink('whennote://open/'), { command: 'open', args: {} });
  assert.deepEqual(parseDeepLink('WHENNOTE://Capture?text=a%20b'), { command: 'capture', args: { text: 'a b' } });
  assert.deepEqual(parseDeepLink('whennote://search'), { command: 'search', args: {} }); // 빈 인자 — 검색창만 연다
  assert.deepEqual(parseDeepLink('whennote://search?q='), { command: 'search', args: {} });
});

test('딥링크: 다른 스킴·모르는 명령·쓰레기는 null', () => {
  assert.equal(parseDeepLink('whenwork://new'), null);
  assert.equal(parseDeepLink('whennote://delete-everything'), null);
  assert.equal(parseDeepLink('https://example.com'), null);
  assert.equal(parseDeepLink(''), null);
  assert.equal(parseDeepLink(null), null);
});

test('fromArgv: argv 어디에 있든 첫 whennote:// 를 집는다', () => {
  assert.equal(fromArgv(['C:\\WHENNOTE.exe', '--allow-file-access', 'whennote://open']), 'whennote://open');
  assert.equal(fromArgv(['electron', '.', '--smoke']), null);
  assert.equal(fromArgv(undefined), null);
});

test('매니페스트: 규약 v1 모양이고 명령 id·title이 다 있다 (when-protocol)', () => {
  const m = buildManifest({ platformName: 'win32', exePath: null, packaged: false });
  assert.equal(m.protocol, 1);
  assert.equal(m.id, 'whennote');
  assert.equal(m.scheme, 'whennote');
  assert.match(m.verify.win32, /WHENNOTE\.exe$/);
  assert.match(m.verify.darwin, /\.app$/);
  assert.equal(m.commands.length, COMMANDS.length);
  for (const c of m.commands) {
    assert.match(c.id, /^[a-z][a-z0-9-]{1,31}$/);
    assert.ok(c.title.trim());
    for (const a of c.args ?? []) assert.equal(a.type, 'string');
  }
  // 명령 id는 parseDeepLink가 아는 것과 같아야 한다 — 매니페스트가 광고한 명령을 앱이 못 받으면 안 된다
  for (const c of m.commands) assert.equal(parseDeepLink(`whennote://${c.id}`)?.command, c.id);
});

test('매니페스트: 패키징본은 실제 실행 파일을 verify에 적는다 — macOS는 .app 번들까지만', () => {
  assert.equal(buildManifest({ platformName: 'win32', exePath: 'D:\\Apps\\WHENNOTE\\WHENNOTE.exe', packaged: true }).verify.win32, 'D:\\Apps\\WHENNOTE\\WHENNOTE.exe');
  assert.equal(buildManifest({ platformName: 'darwin', exePath: '/Users/me/Applications/WHENNOTE.app/Contents/MacOS/WHENNOTE', packaged: true }).verify.darwin, '/Users/me/Applications/WHENNOTE.app');
  // 개발 실행은 electron.exe를 적지 않는다 — 설치본이 없는 PC에서 "있다"고 읽힌다
  assert.match(buildManifest({ platformName: 'win32', exePath: 'D:\\x\\node_modules\\electron\\dist\\electron.exe', packaged: false }).verify.win32, /%LOCALAPPDATA%/);
});
