import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createStore, MIGRATIONS, schemaTables } from '../main/store.mjs';
import { createQueue } from '../main/queue.mjs';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whennote-s-')), 'store.sqlite');
}

const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function seed(store, id, body, captured = at()) {
  store.insertCaptures([{ id, body, captured_at: captured }]);
}

// ── 스키마 가드

test('스키마는 정한 표만 만든다 — 할 일·프로젝트 표가 없다', () => {
  assert.deepEqual(schemaTables(), ['attachment', 'event', 'note', 'note_link', 'note_tag']);
});

test('빈 파일로 열면 최신 버전까지 마이그레이션되고 WAL이다', () => {
  const file = tmpFile();
  const store = createStore(file);
  assert.equal(store.status().ok, true);
  store.close();
  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  raw.close();
});

test('자신보다 높은 스키마 버전의 DB는 열지 않고 안내한다 (STOR-03)', () => {
  const file = tmpFile();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`);
  raw.close();
  const store = createStore(file);
  assert.equal(store.status().ok, false);
  assert.equal(store.status().reason, 'newer');
  assert.throws(() => store.insertCaptures([{ id: 'x', body: '메모', captured_at: at() }]), /store not open/);
});

test('손상된 파일은 옆으로 보관하고 빈 DB로 시작한다 — 지우지 않는다', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'this is not a sqlite database at all, just garbage bytes.....', 'utf8');
  const store = createStore(file);
  assert.equal(store.status().ok, true);
  assert.equal(store.status().reason, 'corrupt');
  const kept = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('store.corrupt-'));
  assert.equal(kept.length, 1);
  store.close();
});

// ── 캡처 반영과 검색

test('insertCaptures 뒤 검색 결과에 제목과 요약이 있다', () => {
  const store = createStore(tmpFile());
  seed(store, 'a', '캐시 무효화 확인\nCDN 퍼지가 느린 이유는 리전별 순차 전파');
  const { items } = store.searchNotes({ q: '' });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '캐시 무효화 확인');
  assert.equal(items[0].snippet, 'CDN 퍼지가 느린 이유는 리전별 순차 전파');
  store.close();
});

test('같은 id로 두 번 반영해도 행은 하나다 — 큐 재시도가 안전하다', () => {
  const store = createStore(tmpFile());
  seed(store, 'dup', '중복');
  seed(store, 'dup', '중복');
  assert.equal(store.count(), 1);
  store.close();
});

test('저장소가 열려 있지 않으면 insertCaptures는 던진다 — 조용한 0은 큐 유실로 이어진다', () => {
  const store = createStore(tmpFile());
  store.close();
  assert.throws(() => store.insertCaptures([{ id: 'x', body: '메모', captured_at: at() }]));
});

test('필수 필드가 빠진 항목은 건너뛰고 나머지는 반영한다', () => {
  const store = createStore(tmpFile());
  const r = store.insertCaptures([
    { id: 'ok', body: '정상', captured_at: at() },
    { id: 'nobody', captured_at: at() },
    { id: 'blank', body: '   ', captured_at: at() },
  ]);
  assert.deepEqual(r, { inserted: 1, skipped: 2 });
  store.close();
});

test('부분 문자열 검색 — 3글자 이상(FTS)과 2글자(LIKE) 모두 찾는다 (SRCH-01)', () => {
  const store = createStore(tmpFile());
  seed(store, 'a', '캐시무효화 확인\n본문');
  seed(store, 'b', '주간 회의\n배포 일정');
  assert.deepEqual(store.searchNotes({ q: '무효화' }).items.map((i) => i.id), ['a']);
  assert.deepEqual(store.searchNotes({ q: '회의' }).items.map((i) => i.id), ['b']);
  assert.deepEqual(store.searchNotes({ q: '시무' }).items.map((i) => i.id), ['a'], '단어 경계에 의존하지 않는다');
  assert.deepEqual(store.searchNotes({ q: '없는말' }).items, []);
  store.close();
});

test('여러 단어는 AND다', () => {
  const store = createStore(tmpFile());
  seed(store, 'a', '주간 회의\n배포 일정 확정');
  seed(store, 'b', '주간 회의\n디자인 리뷰');
  assert.deepEqual(store.searchNotes({ q: '회의 배포' }).items.map((i) => i.id), ['a']);
  store.close();
});

test('초성 검색 — ㅎㅇ로 회의가 찾아진다 (SRCH-02)', () => {
  const store = createStore(tmpFile());
  seed(store, 'a', '주간 회의');
  seed(store, 'b', '캐시 무효화');
  const res = store.searchNotes({ q: 'ㅎㅇ' });
  assert.equal(res.query.choseong, true);
  assert.deepEqual(res.items.map((i) => i.id), ['a']);
  store.close();
});

test('태그 필터 — 검색어의 #태그는 AND로 좁히고 결과에 태그가 실린다 (SRCH-03)', () => {
  const store = createStore(tmpFile());
  seed(store, 'a', '회의 A #회의 #플랫폼');
  seed(store, 'b', '회의 B #회의');
  seed(store, 'c', '다른 것 #플랫폼');
  assert.deepEqual(store.searchNotes({ q: '#회의' }).items.map((i) => i.id).sort(), ['a', 'b']);
  assert.deepEqual(store.searchNotes({ q: '#회의 #플랫폼' }).items.map((i) => i.id), ['a']);
  assert.deepEqual(store.searchNotes({ q: '' }).items.find((i) => i.id === 'a').tags.sort(), ['플랫폼', '회의']);
  assert.deepEqual(
    store.listTags().map((t) => [t.tag, t.count]),
    [['플랫폼', 2], ['회의', 2]]
  );
  store.close();
});

test('정렬은 고정 먼저, 그 다음 최근 열어본 순 (SRCH-05)', () => {
  const store = createStore(tmpFile());
  seed(store, 'old', '옛것', at(-3000));
  seed(store, 'mid', '중간', at(-2000));
  seed(store, 'new', '새것', at(-1000));
  assert.deepEqual(store.searchNotes().items.map((i) => i.id), ['new', 'mid', 'old']);
  store.touchOpened('old');
  assert.deepEqual(store.searchNotes().items.map((i) => i.id), ['old', 'new', 'mid'], '열어본 것이 위로 온다');
  store.setPinned('mid', true);
  assert.deepEqual(store.searchNotes().items.map((i) => i.id), ['mid', 'old', 'new'], '고정이 맨 위다');
  store.close();
});

test('1,000건에서 검색이 50ms 안에 끝난다 (SRCH-04)', () => {
  const store = createStore(tmpFile());
  const entries = [];
  for (let i = 0; i < 1000; i++) {
    entries.push({
      id: `n${i}`,
      body: `메모 ${i} 제목 #태그${i % 7}\n본문 내용 ${i % 13 === 0 ? '캐시 무효화 이야기' : '다른 이야기'} ${'가나다라마바사'.repeat(8)}`,
      captured_at: at(-i * 1000),
    });
  }
  store.insertCaptures(entries);
  for (const q of ['무효화', '회의', 'ㅁㅎㅎ', '#태그3', '']) {
    const t0 = performance.now();
    store.searchNotes({ q });
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `"${q}" 검색이 ${ms.toFixed(1)}ms 걸렸다`);
  }
  store.close();
});

// ── 편집·태그·링크

test('updateNote는 제목·초성·태그·링크 색인을 다시 계산하고, 같은 본문이면 아무것도 하지 않는다', () => {
  const store = createStore(tmpFile());
  seed(store, 'a', '처음 제목 #하나');
  const same = store.updateNote('a', '처음 제목 #하나');
  assert.equal(same.changed, false);
  const res = store.updateNote('a', '바뀐 제목 #둘\n[[없는 메모]]');
  assert.equal(res.changed, true);
  assert.equal(res.title, '바뀐 제목 #둘', '첫 줄이 곧 제목이다 — 태그도 제목의 일부다');
  const n = store.getNote('a');
  assert.deepEqual(n.tags, ['둘']);
  assert.deepEqual(n.links, [{ title: '없는 메모', to_id: null }]);
  assert.deepEqual(store.searchNotes({ q: 'ㅂㄲ' }).items.map((i) => i.id), ['a'], '초성 색인도 갱신된다');
  assert.equal(store.updateNote('없는id', 'x'), null);
  store.close();
});

test('[[제목]]은 저장 시점에 대상 메모로 해석되고 백링크로 보인다 (LINK-02, LINK-03)', () => {
  const store = createStore(tmpFile());
  seed(store, 'tpl', '릴리즈 노트 템플릿\n형식');
  seed(store, 'mtg', '주간 회의\n[[릴리즈 노트 템플릿]] 참고');
  assert.deepEqual(store.getNote('mtg').links, [{ title: '릴리즈 노트 템플릿', to_id: 'tpl' }]);
  assert.deepEqual(store.getNote('tpl').backlinks.map((b) => b.id), ['mtg']);
  store.close();
});

test('먼저 쓴 링크도 나중에 그 제목의 메모가 생기면 이어진다', () => {
  const store = createStore(tmpFile());
  seed(store, 'mtg', '회의\n[[구조 메모]]를 나중에');
  assert.equal(store.getNote('mtg').links[0].to_id, null);
  seed(store, 'arch', '구조 메모\n내용');
  assert.equal(store.getNote('mtg').links[0].to_id, 'arch');
  assert.deepEqual(store.getNote('arch').backlinks.map((b) => b.id), ['mtg']);
  store.close();
});

test('대상 메모의 제목을 바꿔도 링크는 깨지지 않는다 (LINK-04)', () => {
  const store = createStore(tmpFile());
  seed(store, 'tpl', '옛 제목');
  seed(store, 'mtg', '회의\n[[옛 제목]]');
  store.updateNote('tpl', '새 제목');
  assert.equal(store.getNote('mtg').links[0].to_id, 'tpl');
  assert.deepEqual(store.getNote('tpl').backlinks.map((b) => b.id), ['mtg']);
  store.close();
});

test('getNote는 opened_at을 건드리지 않고 touchOpened가 따로 올린다', () => {
  const store = createStore(tmpFile());
  seed(store, 'a', '메모', at(-5000));
  const before = store.getNote('a').opened_at;
  assert.equal(store.getNote('a').opened_at, before);
  store.touchOpened('a');
  assert.ok(store.getNote('a').opened_at > before);
  store.close();
});

// ── 고정·아카이브·삭제·정리

test('아카이브한 메모는 기본 검색에서 빠지고 archived 옵션으로만 보인다', () => {
  const store = createStore(tmpFile());
  seed(store, 'a', '보관할 것');
  seed(store, 'b', '남을 것');
  store.setArchived('a', true);
  assert.deepEqual(store.searchNotes().items.map((i) => i.id), ['b']);
  assert.deepEqual(store.searchNotes({ archived: true }).items.map((i) => i.id), ['a']);
  store.setArchived('a', false);
  assert.equal(store.searchNotes().items.length, 2);
  store.close();
});

test('소프트 삭제·복구·30일 뒤 정리, 정리되면 그 메모를 가리키던 링크는 미해결로 돌아간다 (MAIN-05)', () => {
  const file = tmpFile();
  const store = createStore(file);
  seed(store, 'tgt', '대상');
  seed(store, 'src', '출발\n[[대상]] #태그');
  store.removeNote('src');
  assert.deepEqual(store.searchNotes().items.map((i) => i.id), ['tgt']);
  assert.deepEqual(store.getNote('tgt').backlinks, [], '지운 메모는 백링크에서도 빠진다');
  store.restoreNote('src');
  assert.equal(store.searchNotes().items.length, 2);

  store.removeNote('tgt');
  store.close();
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE note SET deleted_at = ? WHERE id = 'tgt'").run(at(-40 * 86400_000));
  raw.close();
  const again = createStore(file);
  assert.equal(again.purgeDeleted(30).count, 1);
  assert.equal(again.getNote('tgt'), null);
  assert.equal(again.getNote('src').links[0].to_id, null);
  again.close();
});

// ── 큐와의 계약

test('큐 재반영은 store.insertCaptures를 거쳐 검색에 나타난다 — 강제종료 경로의 단위 재현', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whennote-qs-'));
  const q = createQueue(path.join(dir, 'queue.jsonl'));
  q.append({ id: 'crash', body: '죽기 직전 메모', captured_at: at() });
  const store = createStore(path.join(dir, 'store.sqlite'));
  const n = q.replayPending((entries) => store.insertCaptures(entries));
  assert.equal(n, 1);
  assert.equal(store.searchNotes({ q: '직전' }).items[0].title, '죽기 직전 메모');
  store.close();
});

// ── 고정 순서 (D-10)

test('고정하면 고정 그룹 맨 아래로 가고, Shift 이동은 고정끼리만 자리를 바꾼다', () => {
  const store = createStore(tmpFile());
  seed(store, 'a', '에이', at(-3000));
  seed(store, 'b', '비', at(-2000));
  seed(store, 'c', '씨', at(-1000));
  seed(store, 'd', '디 (고정 아님)', at(-500));
  store.setPinned('a', true);
  store.setPinned('b', true);
  store.setPinned('c', true);
  const ids = () => store.searchNotes().items.map((i) => i.id);
  assert.deepEqual(ids(), ['a', 'b', 'c', 'd'], '고정한 순서대로 선다 — 최근 열어본 순이 아니다');
  assert.equal(store.movePinned('c', -1), true);
  assert.deepEqual(ids(), ['a', 'c', 'b', 'd']);
  assert.equal(store.movePinned('a', -1), false, '맨 위에서 더 올라가지 않는다');
  assert.equal(store.movePinned('d', -1), false, '고정이 아니면 움직이지 않는다');
  assert.deepEqual(ids(), ['a', 'c', 'b', 'd']);
  store.setPinned('c', false);
  assert.deepEqual(ids(), ['a', 'b', 'd', 'c'], '해제하면 번호를 버리고 최근 열어본 순으로 돌아간다');
  store.close();
});

test('v1 DB를 열면 v2로 이행되며 기존 고정 메모가 고정한 순서로 번호를 받고 이행 전 백업이 남는다', () => {
  const file = tmpFile();
  const raw = new DatabaseSync(file);
  MIGRATIONS[0](raw); // v1 스키마 그대로
  raw.exec('PRAGMA user_version = 1');
  const ins = raw.prepare(
    `INSERT INTO note (id, body, title, title_cho, body_cho, created_at, updated_at, opened_at, pinned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run('late', '나중에 고정', '나중에 고정', 'ㄴㅈㅇ ㄱㅈ', 'ㄴㅈㅇ ㄱㅈ', at(), at(), at(-9000), at(-1000));
  ins.run('early', '먼저 고정', '먼저 고정', 'ㅁㅈ ㄱㅈ', 'ㅁㅈ ㄱㅈ', at(), at(), at(-100), at(-5000));
  raw.close();
  const store = createStore(file);
  assert.equal(store.status().ok, true);
  assert.deepEqual(store.searchNotes().items.map((i) => i.id), ['early', 'late']);
  const backups = fs.readdirSync(path.join(path.dirname(file), 'backups')).filter((f) => /^store-v1-\d{8}\.sqlite$/.test(f));
  assert.equal(backups.length, 1, '이행 직전 v1 백업이 하나 남는다');
  store.close();
});

// ── 첨부·내보내기·가져오기 (MAIN-08, STOR-04, DATA-01·02)

test('첨부는 메모에 묶이고, 메모가 정리되면 지울 파일 이름으로 돌아온다 (STOR-04)', () => {
  const file = tmpFile();
  const store = createStore(file);
  seed(store, 'a', '그림 메모');
  store.addAttachment('a', '11111111-1111-4111-8111-111111111111.png');
  assert.deepEqual(store.attachmentFiles(), ['11111111-1111-4111-8111-111111111111.png']);
  store.removeNote('a');
  assert.deepEqual(store.attachmentFiles({ includeDeleted: false }), [], '지운 메모의 첨부는 산 것으로 치지 않는다');
  store.close();
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE note SET deleted_at = ? WHERE id = 'a'").run(at(-40 * 86400_000));
  raw.close();
  const again = createStore(file);
  assert.deepEqual(again.purgeDeleted(30), { count: 1, files: ['11111111-1111-4111-8111-111111111111.png'] });
  assert.deepEqual(again.attachmentFiles(), []);
  again.close();
});

test('exportAll → importAll 왕복: 메모·고정·아카이브·첨부가 같고 태그·링크·초성은 다시 계산된다 (DATA-02)', () => {
  const a = createStore(tmpFile());
  seed(a, 'tpl', '릴리즈 노트 템플릿\n형식', at(-3000));
  seed(a, 'mtg', '주간 회의 #회의\n[[릴리즈 노트 템플릿]] 참고', at(-2000));
  seed(a, 'gone', '지운 것', at(-1000));
  a.setPinned('mtg', true);
  a.setArchived('tpl', true);
  a.removeNote('gone');
  a.addAttachment('mtg', '11111111-1111-4111-8111-111111111111.png');
  a.logEvent('test', 'x');
  const data = a.exportAll();
  assert.equal(data.app, 'whennote');
  assert.equal(data.note.length, 3, '지운 메모도 내보낸다 — 30일 안이면 되돌릴 수 있어야 한다');
  assert.ok(!('title_cho' in data.note[0]) && !('tags' in data.note[0]), '파생값은 내보내지 않는다');
  a.close();

  const bFile = tmpFile();
  const b = createStore(bFile);
  seed(b, 'old', '가져오기 전에 있던 것');
  const out = b.importAll(JSON.parse(JSON.stringify(data)));
  assert.equal(out.note, 3);
  assert.match(out.backup, /^store-import-/);
  assert.ok(fs.existsSync(path.join(path.dirname(bFile), 'backups', out.backup)), '가져오기 직전 백업이 남는다');
  assert.equal(b.getNote('old'), null, '지금 데이터는 파일의 내용으로 갈아끼워진다');
  assert.deepEqual(b.searchNotes().items.map((i) => i.id), ['mtg'], '아카이브·삭제는 기본 목록에서 빠진다');
  assert.equal(b.searchNotes().items[0].pinned, true);
  assert.deepEqual(b.searchNotes({ archived: true }).items.map((i) => i.id), ['tpl']);
  assert.deepEqual(b.getNote('mtg').tags, ['회의'], '태그는 본문에서 다시 계산된다');
  assert.equal(b.getNote('mtg').links[0].to_id, 'tpl', '링크는 대상이 들어온 뒤 해석된다');
  assert.deepEqual(b.searchNotes({ q: 'ㅎㅇ' }).items.map((i) => i.id), ['mtg'], '초성 색인도 다시 만들어진다');
  assert.deepEqual(b.attachmentFiles(), ['11111111-1111-4111-8111-111111111111.png']);
  assert.equal(b.allNotes().length, 2, '마크다운 내보내기는 지운 것을 뺀다');
  b.close();
});

test('importAll은 잘못된 파일을 백업도 만들기 전에 거절한다', () => {
  const store = createStore(tmpFile());
  assert.throws(() => store.importAll({ app: 'whenwork', note: [] }), /WHENNOTE가 내보낸 파일이 아닙니다/);
  store.close();
});
