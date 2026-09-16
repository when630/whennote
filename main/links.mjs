// main/links.mjs — 본문에서 파생되는 것들: 제목, #태그, [[링크]]. 순수 모듈(node --test 대상).
//
// 태그와 링크는 본문 밖에 따로 저장하지 않는다(D-02). note_tag·note_link 표는 여기서 뽑은 값으로
// 저장할 때마다 갈아끼우는 인덱스일 뿐이고, 원본은 늘 body다.

const TITLE_MAX = 200;

// 첫 줄이 제목이다(CAP-03). 마크다운 제목 기호(# )는 떼고, 빈 줄만 있으면 작성 시각이 제목이다.
export function titleOf(body, createdAt) {
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.replace(/^\s*#{1,6}\s+/, '').trim();
    if (line) return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX) : line;
  }
  return formatStamp(createdAt);
}

// "2026-09-16 09:41" — 로컬 시각. 제목으로 쓰이므로 사람이 읽는 형식이다.
export function formatStamp(iso) {
  const d = new Date(iso ?? NaN);
  if (Number.isNaN(d.getTime())) return '메모';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// #태그 — 앞이 글자·숫자·#가 아닌 자리에서 시작하는 것만. "회의#태그"의 #는 태그가 아니고,
// "# 제목"(마크다운 제목)은 뒤에 공백이 와서 걸리지 않으며, "#201"은 숫자만이라 뺀다(LINK-01).
const TAG_RE = /(^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu;

export function extractTags(body) {
  const out = new Set();
  for (const m of String(body ?? '').matchAll(TAG_RE)) {
    const tag = m[2];
    if (/^\d+$/.test(tag)) continue;
    out.add(tag);
  }
  return [...out];
}

// [[제목]] — 줄 안에서만, 대괄호를 품지 않는 것만. 앞뒤 공백은 뗀다.
const LINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

export function extractLinks(body) {
  const out = new Set();
  for (const m of String(body ?? '').matchAll(LINK_RE)) {
    const title = m[1].trim();
    if (title) out.add(title);
  }
  return [...out];
}
