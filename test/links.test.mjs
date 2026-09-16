import test from 'node:test';
import assert from 'node:assert/strict';
import { titleOf, extractTags, extractLinks, formatStamp } from '../main/links.mjs';

test('첫 비어 있지 않은 줄이 제목이고 마크다운 # 기호는 뗀다 (CAP-03)', () => {
  assert.equal(titleOf('\n\n## 주간 회의  \n본문'), '주간 회의');
  assert.equal(titleOf('그냥 한 줄'), '그냥 한 줄');
});

test('본문이 비어 있으면 작성 시각이 제목이다', () => {
  const at = '2026-09-16T00:41:00.000Z';
  assert.equal(titleOf('   \n', at), formatStamp(at));
  assert.match(formatStamp(at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('제목은 200자에서 잘린다', () => {
  assert.equal(titleOf('가'.repeat(300)).length, 200);
});

test('#태그는 단어 경계에서만, 숫자만은 제외, 중복 제거 (LINK-01)', () => {
  assert.deepEqual(extractTags('#회의 내용. (#플랫폼) 그리고 #회의 다시, 이슈 #201 확인, 이메일a#b 아님'), ['회의', '플랫폼']);
});

test('마크다운 제목(# 제목, ## 소제목)은 태그가 아니다', () => {
  assert.deepEqual(extractTags('# 제목\n## 소제목\n#진짜태그'), ['진짜태그']);
});

test('태그에는 -와 _가 들어갈 수 있고 문장부호에서 끝난다', () => {
  assert.deepEqual(extractTags('#읽을-것, #todo_2 끝.'), ['읽을-것', 'todo_2']);
});

test('[[제목]] 링크를 뽑고 앞뒤 공백을 떼며 중복을 제거한다', () => {
  assert.deepEqual(extractLinks('참고 [[ 릴리즈 노트 템플릿 ]]와 [[알림 배치 구조 메모]], 다시 [[릴리즈 노트 템플릿]]'), [
    '릴리즈 노트 템플릿',
    '알림 배치 구조 메모',
  ]);
});

test('대괄호가 섞이거나 줄을 넘는 것은 링크가 아니다', () => {
  assert.deepEqual(extractLinks('[[a[b]] [[줄\n바꿈]] [[]]'), []);
});
