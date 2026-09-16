// main/search.mjs — 검색어 해석과 한글 초성 변환. Electron·SQLite에 기대지 않는 순수 모듈이라
// node --test로 검증한다. SQL을 조립하는 쪽(store.mjs)은 여기서 나온 조각만 쓴다.
//
// 검색 규칙(03_기술_스펙 §5):
//   - 3글자 이상 단어는 FTS5 trigram MATCH, 1~2글자는 LIKE 폴백(trigram은 3자 미만을 못 찾는다 —
//     Electron 43.3 내장 SQLite 3.53에서 "회의"가 0건, "무효화"가 1건으로 실측)
//   - 단어가 전부 초성 자모(ㄱ-ㅎ)면 초성 컬럼(title_cho·body_cho)에 LIKE
//   - `#태그` 토큰은 검색어가 아니라 태그 필터(AND)

// 초성 19개 — 유니코드 완성형 한글의 초성 순서와 같다
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

// 완성형 한글 한 글자를 초성 한 글자로 바꾼다. 한글이 아닌 글자는 그대로 둔다.
// **UTF-16 단위로 1:1**이라 결과 문자열의 인덱스가 원문 인덱스와 같다 — 렌더러가 초성 검색
// 결과를 원문 위에 강조할 때 이 성질에 기댄다(renderer/view.js의 toChoseong도 같은 구현이어야
// 하고, view.test가 두 구현이 같은 답을 내는지 대조한다).
export function toChoseong(str) {
  const s = String(str ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xac00 && code <= 0xd7a3) out += CHO[Math.floor((code - 0xac00) / 588)];
    else out += s[i];
  }
  return out;
}

// 태그로 인정하는 모양 — 글자·숫자·_·-. 숫자만으로 된 것(#201)은 이슈 번호이므로 태그가 아니다(LINK-01).
export function isTagWord(word) {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(word) && !/^\d+$/.test(word);
}

// 검색어 한 줄을 { terms, tags, choseong }로 가른다.
//   "회의 #플랫폼" → terms ['회의'], tags ['플랫폼'], choseong false
//   "ㅎㅇ"          → terms ['ㅎㅇ'], tags [], choseong true
export function parseQuery(raw) {
  const terms = [];
  const tags = [];
  for (const tok of String(raw ?? '').trim().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('#') && tok.length > 1 && isTagWord(tok.slice(1))) tags.push(tok.slice(1));
    else terms.push(tok);
  }
  const choseong = terms.length > 0 && terms.every((t) => /^[ㄱ-ㅎ]+$/.test(t));
  return { terms, tags, choseong };
}

export const FTS_MIN_CHARS = 3;

// FTS5 MATCH로 보낼 단어와 LIKE로 보낼 단어를 가른다. 글자 수는 코드포인트 기준(trigram과 같다).
export function splitTerms(terms) {
  const fts = [];
  const like = [];
  for (const t of terms) ([...t].length >= FTS_MIN_CHARS ? fts : like).push(t);
  return { fts, like };
}

// FTS5 MATCH 식. 각 단어를 구문("...")으로 감싸 연산자 해석을 막고 AND로 잇는다.
// 큰따옴표는 두 번 써서 이스케이프한다(FTS5 구문 규칙).
export function ftsMatch(words) {
  if (!words.length) return null;
  return words.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' AND ');
}

// LIKE 패턴. %·_·\를 이스케이프하고 양쪽에 %를 붙인다 — SQL 쪽은 ESCAPE '\'를 명시해야 한다.
export function likePattern(term) {
  return '%' + String(term).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

// 결과 목록의 요약 한 줄. 첫 줄(제목)을 뺀 본문에서 첫 일치 주변을 자른다. 일치가 없으면 앞부분.
export function makeSnippet(body, { terms = [], choseong = false, width = 110 } = {}) {
  const text = String(body ?? '')
    .split('\n')
    .slice(1)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  let at = -1;
  if (terms.length) {
    const hay = choseong ? toChoseong(text) : text.toLowerCase();
    for (const t of terms) {
      const i = hay.indexOf(choseong ? t : t.toLowerCase());
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
  }
  if (at < 0) return text.length > width ? text.slice(0, width) + '…' : text;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
