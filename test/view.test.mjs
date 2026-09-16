import test from 'node:test';
import assert from 'node:assert/strict';
import '../renderer/view.js';
import '../renderer/md.js';
import { toChoseong as mainToChoseong } from '../main/search.mjs';

const { toChoseong, highlightRanges, splitByRanges, relativeTime } = globalThis.VIEW;
const { parse, inline } = globalThis.MD;

test('렌더러와 main의 toChoseong은 같은 답을 낸다 — 두 구현이 갈라지면 강조 위치가 어긋난다', () => {
  for (const s of ['회의', '캐시 무효화 2026', 'abc 한글 mix', '똠방각하', '']) {
    assert.equal(toChoseong(s), mainToChoseong(s));
  }
});

test('highlightRanges는 대소문자를 무시하고 모든 일치를 찾아 겹치면 합친다', () => {
  assert.deepEqual(highlightRanges('Cache cache CACHE', ['cache']), [[0, 5], [6, 11], [12, 17]]);
  assert.deepEqual(highlightRanges('무효화 확인', ['무효화', '효화 확']), [[0, 5]]);
  assert.deepEqual(highlightRanges('아무것도', []), []);
});

test('초성 검색의 강조는 원문 인덱스 위에 놓인다', () => {
  const text = '오늘 주간 회의 기록';
  const ranges = highlightRanges(text, ['ㅎㅇ'], true);
  assert.deepEqual(ranges.map(([s, e]) => text.slice(s, e)), ['회의']);
});

test('splitByRanges는 조각을 순서대로 hit 표시와 함께 돌려준다', () => {
  assert.deepEqual(splitByRanges('a회의b', [[1, 3]]), [
    { text: 'a', hit: false },
    { text: '회의', hit: true },
    { text: 'b', hit: false },
  ]);
  assert.deepEqual(splitByRanges('', []), [{ text: '', hit: false }]);
});

test('relativeTime은 사람 말로 시간을 말한다', () => {
  const now = new Date('2026-09-16T09:00:00+09:00').getTime();
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(ago(10_000), now), '방금');
  assert.equal(relativeTime(ago(5 * 60_000), now), '5분 전');
  assert.equal(relativeTime(ago(3 * 3600_000), now), '3시간 전');
  assert.equal(relativeTime(ago(26 * 3600_000), now), '어제');
  assert.equal(relativeTime(ago(4 * 86400_000), now), '4일 전');
  assert.match(relativeTime(ago(30 * 86400_000), now), /^\d+월 \d+일$/);
  assert.match(relativeTime(ago(400 * 86400_000), now), /^\d{4}년 /);
  assert.equal(relativeTime('깨진값', now), '');
});

// ── 마크다운 (MAIN-04)

test('inline은 코드·굵게·[[링크]]·#태그를 조각으로 가른다', () => {
  assert.deepEqual(inline('보라 `x` **굵게** [[구조 메모]] #태그 #201'), [
    { text: '보라 ' },
    { text: 'x', kind: 'code' },
    { text: ' ' },
    { text: '굵게', kind: 'bold' },
    { text: ' ' },
    { text: '구조 메모', kind: 'link' },
    { text: ' ' },
    { text: '#태그', kind: 'tag', tag: '태그' },
    { text: ' ' },
    { text: '#201' },
  ]);
});

test('parse는 제목·목록·인용·코드 블록·문단을 나누고, 체크박스는 목록 항목의 상태다', () => {
  const blocks = parse('# 제목\n- 하나\n- [ ] 둘\n1. 셋\n> 인용\n```js\nconst a = 1;\n```\n문단 하나\n이어지는 줄');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'list', 'quote', 'code', 'para']
  );
  const items = blocks[1].items;
  assert.equal(items.length, 3, '이어진 목록 줄은 한 블록이다 — 번호·글머리는 항목마다 따로 본다');
  assert.deepEqual(items.map((i) => i.ordered), [false, false, true]);
  assert.equal(items[1].parts[0].text, '둘');
  assert.equal(items[1].checked, false);
  assert.equal(items[0].checked, null);
  assert.equal(blocks[3].lang, 'js');
  assert.deepEqual(blocks[3].lines, ['const a = 1;']);
  assert.equal(blocks[4].parts.map((p) => p.text).join(''), '문단 하나 이어지는 줄');
});

test('닫히지 않은 코드 블록도 잃지 않고 보여준다', () => {
  const blocks = parse('```\n미완');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].lines, ['미완']);
});

test('inline은 첨부 폴더 안의 이미지만 그림으로, 다른 경로는 글자로 둔다 (D-11)', () => {
  const parts = inline('앞 ![스크린샷](attachments/11111111-1111-4111-8111-111111111111.png) 뒤 ![x](https://a/b.png)');
  assert.deepEqual(parts[1], { text: '스크린샷', kind: 'image', file: '11111111-1111-4111-8111-111111111111.png' });
  assert.deepEqual(parts[3], { text: '![x](https://a/b.png)' });
});

test('pickImage는 형식이 image/*인 파일 항목, 형식이 비어도 이름이 이미지인 항목을 고르고 글만 있으면 null', () => {
  const { pickImage } = globalThis.VIEW;
  const file = (type, name) => ({ type, name });
  const item = (kind, type, f) => ({ kind, type, getAsFile: () => f });
  const png = file('image/png', 'image.png');
  assert.equal(pickImage({ items: [item('string', 'text/plain', null), item('file', 'image/png', png)], files: [] }), png);
  const noType = file('', 'screenshot.PNG');
  assert.equal(pickImage({ items: [item('file', '', noType)], files: [] }), noType);
  assert.equal(pickImage({ items: [item('string', 'text/plain', null)], files: [] }), null);
  assert.equal(pickImage({ items: [], files: [png] }), png, 'items가 비어도 files를 본다');
  assert.equal(pickImage(null), null);
});

// ── 넓힌 마크다운 (기울임·취소선·외부 링크·URL·구분선·중첩·체크박스)

test('inline은 기울임·취소선·외부 링크·URL을 가르고 snake_case와 URL 끝 문장부호를 건드리지 않는다', () => {
  assert.deepEqual(inline('*기울임* _이것도_ ~~취소~~ snake_case_name'), [
    { text: '기울임', kind: 'italic' },
    { text: ' ' },
    { text: '이것도', kind: 'italic' },
    { text: ' ' },
    { text: '취소', kind: 'strike' },
    { text: ' snake_case_name' },
  ]);
  assert.deepEqual(inline('[문서](https://example.com/a) 와 https://example.com/b.'), [
    { text: '문서', kind: 'url', href: 'https://example.com/a' },
    { text: ' 와 ' },
    { text: 'https://example.com/b', kind: 'url', href: 'https://example.com/b' },
    { text: '.' },
  ]);
  assert.deepEqual(inline('**굵게**와 *기울임*'), [{ text: '굵게', kind: 'bold' }, { text: '와 ' }, { text: '기울임', kind: 'italic' }]);
});

test('parse는 구분선·중첩 목록·체크박스를 알아본다', () => {
  const blocks = parse('- 하나\n  - 하나의 아이\n- [ ] 할 것\n- [x] 한 것\n\n---\n\n1. 첫째\n2. 둘째');
  assert.deepEqual(blocks.map((b) => b.type), ['list', 'hr', 'list']);
  const items = blocks[0].items;
  assert.deepEqual(items.map((i) => [i.depth, i.checked, i.line]), [[0, null, 0], [1, null, 1], [0, false, 2], [0, true, 3]]);
  assert.equal(items[2].parts[0].text, '할 것', '체크박스 표식은 글에서 뺀다');
  assert.deepEqual(blocks[2].items.map((i) => i.ordered), [true, true]);
});

test('toggleTask는 그 줄의 체크박스만 뒤집고 다른 줄은 두지 않는다', () => {
  const { toggleTask } = globalThis.MD;
  const src = '제목\n- [ ] 하나\n- [x] 둘\n그냥 글';
  assert.equal(toggleTask(src, 1), '제목\n- [x] 하나\n- [x] 둘\n그냥 글');
  assert.equal(toggleTask(src, 2), '제목\n- [ ] 하나\n- [ ] 둘\n그냥 글');
  assert.equal(toggleTask(src, 3), src, '체크박스가 아닌 줄은 그대로');
});

test('editList — Enter는 표식을 이어 쓰고, 빈 항목에서는 목록을 끝내며, Tab은 두 칸 들여쓴다', () => {
  const { editList } = globalThis.VIEW;
  const t1 = '- 하나';
  assert.deepEqual(editList(t1, t1.length, t1.length, 'enter'), { text: '- 하나\n- ', start: 7, end: 7 });
  const t2 = '1. 첫째';
  assert.equal(editList(t2, t2.length, t2.length, 'enter').text, '1. 첫째\n2. ');
  const t3 = '- [x] 한 것';
  assert.equal(editList(t3, t3.length, t3.length, 'enter').text, '- [x] 한 것\n- [ ] ');
  const t4 = '- 하나\n- ';
  assert.deepEqual(editList(t4, t4.length, t4.length, 'enter'), { text: '- 하나\n', start: 5, end: 5 });
  assert.equal(editList('그냥 글', 4, 4, 'enter'), null, '목록이 아니면 기본 동작');
  assert.deepEqual(editList('- 하나', 3, 3, 'indent'), { text: '  - 하나', start: 5, end: 5 });
  assert.deepEqual(editList('  - 하나', 5, 5, 'outdent'), { text: '- 하나', start: 3, end: 3 });
  assert.equal(editList('- 하나', 3, 3, 'outdent'), null);
});
