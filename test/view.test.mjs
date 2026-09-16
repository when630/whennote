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

test('parse는 제목·목록·인용·코드 블록·문단을 나누고 체크박스는 특별 취급하지 않는다', () => {
  const blocks = parse('# 제목\n- 하나\n- [ ] 둘\n1. 셋\n> 인용\n```js\nconst a = 1;\n```\n문단 하나\n이어지는 줄');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'list', 'list', 'quote', 'code', 'para']
  );
  assert.equal(blocks[1].ordered, false);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[1].items[1][0].text, '[ ] 둘', '체크박스 문법은 그냥 글자다');
  assert.equal(blocks[2].ordered, true);
  assert.equal(blocks[4].lang, 'js');
  assert.deepEqual(blocks[4].lines, ['const a = 1;']);
  assert.equal(blocks[5].parts.map((p) => p.text).join(''), '문단 하나 이어지는 줄');
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
