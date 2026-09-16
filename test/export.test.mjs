import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExport, safeFilename, noteToMarkdown, referencedAttachments } from '../main/export.mjs';

const good = () => ({
  app: 'whennote',
  export_version: 1,
  schema_version: 2,
  note: [{ id: 'n1', body: '제목\n본문', created_at: '2026-09-16T00:00:00.000Z' }],
  attachment: [{ id: 'a1', note_id: 'n1', file: '11111111-1111-4111-8111-111111111111.png' }],
});

test('정상 파일은 통과한다', () => {
  assert.equal(validateExport(good(), 2), null);
});

test('다른 앱·깨진 구조·상위 스키마는 사람이 읽는 이유로 거절한다', () => {
  assert.match(validateExport({ ...good(), app: 'whenwork' }, 2), /WHENNOTE가 내보낸 파일이 아닙니다/);
  assert.match(validateExport({ ...good(), note: 'x' }, 2), /형식이 올바르지 않습니다/);
  assert.match(validateExport({ ...good(), schema_version: 9 }, 2), /앱을 업데이트/);
  assert.match(validateExport(null, 2), /읽을 수 없는/);
});

test('메모의 필수 필드가 빠지면 거절한다', () => {
  const d = good();
  d.note[0].created_at = '어제';
  assert.match(validateExport(d, 2), /메모 자료가 손상/);
  const e = good();
  delete e.note[0].body;
  assert.match(validateExport(e, 2), /메모 자료가 손상/);
});

test('첨부가 없는 메모를 가리키면 거절한다', () => {
  const d = good();
  d.attachment[0].note_id = 'ghost';
  assert.match(validateExport(d, 2), /첨부가 가리키는 메모/);
});

test('safeFilename은 금지 문자를 걷어내고 id 앞 8자로 겹침을 막는다', () => {
  assert.equal(safeFilename('회의: 9/19 배포?', 'abcdef12-3456'), '회의 9 19 배포 abcdef12.md');
  assert.equal(safeFilename('   ', 'abcdef12-3456'), '메모 abcdef12.md');
  assert.ok(safeFilename('가'.repeat(200), 'abcdef12').length < 80);
  assert.equal(safeFilename('끝에 점...', 'abcdef12'), '끝에 점 abcdef12.md');
});

test('noteToMarkdown은 frontmatter에 태그·시각·상태를 넣고 본문은 그대로 둔다', () => {
  const md = noteToMarkdown(
    { id: 'n1', body: '제목\n\n본문 #태그 ![이미지](attachments/x.png)', created_at: 'C', updated_at: 'U', pinned_at: 'P', archived_at: null },
    ['태그', 'a-b']
  );
  assert.equal(
    md,
    ['---', 'id: n1', 'created: C', 'updated: U', 'tags: ["태그", "a-b"]', 'pinned: true', '---', '', '제목', '', '본문 #태그 ![이미지](attachments/x.png)', ''].join('\n')
  );
});

test('referencedAttachments는 attachments/ 안의 이름만 뽑는다', () => {
  const body = '![a](attachments/11111111-1111-4111-8111-111111111111.png) ![b](https://x/y.png) attachments/../etc';
  assert.deepEqual(referencedAttachments(body), ['11111111-1111-4111-8111-111111111111.png']);
});
