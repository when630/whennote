import test from 'node:test';
import assert from 'node:assert/strict';
import { toChoseong, parseQuery, splitTerms, ftsMatch, likePattern, makeSnippet, isTagWord } from '../main/search.mjs';

test('toChoseong은 완성형 한글만 초성으로 바꾸고 나머지는 그대로 둔다', () => {
  assert.equal(toChoseong('회의'), 'ㅎㅇ');
  assert.equal(toChoseong('캐시 무효화 2026'), 'ㅋㅅ ㅁㅎㅎ 2026');
  assert.equal(toChoseong('abc'), 'abc');
  assert.equal(toChoseong(''), '');
});

test('toChoseong은 UTF-16 길이를 보존한다 — 렌더러가 인덱스를 그대로 강조에 쓴다', () => {
  for (const s of ['회의록 📝 정리', 'a한b글c', '똠방각하']) assert.equal(toChoseong(s).length, s.length);
});

test('parseQuery는 #태그를 필터로 떼고 나머지를 검색어로 둔다', () => {
  assert.deepEqual(parseQuery('회의 #플랫폼  #아이디어'), { terms: ['회의'], tags: ['플랫폼', '아이디어'], choseong: false });
});

test('숫자만 있는 #201은 태그가 아니라 검색어다 (LINK-01)', () => {
  assert.deepEqual(parseQuery('#201 이슈'), { terms: ['#201', '이슈'], tags: [], choseong: false });
  assert.equal(isTagWord('201'), false);
  assert.equal(isTagWord('v2'), true);
});

test('전부 초성 자모면 초성 검색이다', () => {
  assert.equal(parseQuery('ㅎㅇ').choseong, true);
  assert.equal(parseQuery('ㅎㅇ ㅁㅁ').choseong, true);
  assert.equal(parseQuery('ㅎㅇ 회의').choseong, false);
  assert.equal(parseQuery('#태그').choseong, false);
  assert.equal(parseQuery('').choseong, false);
});

test('3글자 이상은 FTS, 그 미만은 LIKE로 간다 — trigram은 2자를 못 찾는다', () => {
  assert.deepEqual(splitTerms(['회의', '무효화', 'ab', 'abc']), { fts: ['무효화', 'abc'], like: ['회의', 'ab'] });
});

test('ftsMatch는 단어를 구문으로 감싸 AND로 잇고 큰따옴표를 이스케이프한다', () => {
  assert.equal(ftsMatch(['무효화', 'a"b"c']), '"무효화" AND "a""b""c"');
  assert.equal(ftsMatch([]), null);
});

test('likePattern은 %·_·\\를 이스케이프한다', () => {
  assert.equal(likePattern('50%_a\\b'), '%50\\%\\_a\\\\b%');
});

test('makeSnippet은 첫 줄을 빼고 첫 일치 주변을 자른다', () => {
  const body = '제목 줄\n앞부분 ' + '가'.repeat(100) + ' 캐시 무효화 이야기 ' + '나'.repeat(100);
  const s = makeSnippet(body, { terms: ['무효화'] });
  assert.ok(s.includes('무효화'));
  assert.ok(s.startsWith('…'), '앞이 잘렸으면 말줄임이 붙어야 한다');
  assert.ok(!s.includes('제목 줄'), '제목 줄은 요약에 넣지 않는다');
});

test('makeSnippet은 초성 검색이면 초성으로 위치를 찾는다', () => {
  const s = makeSnippet('제목\n' + '가'.repeat(80) + ' 회의 기록', { terms: ['ㅎㅇ'], choseong: true });
  assert.ok(s.includes('회의'));
});

test('makeSnippet은 일치가 없으면 앞부분을, 본문이 없으면 빈 문자열을 준다', () => {
  assert.equal(makeSnippet('제목만'), '');
  assert.equal(makeSnippet('제목\n둘째 줄\n셋째 줄', { terms: ['없음'] }), '둘째 줄 셋째 줄');
});
