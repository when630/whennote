// 화면 계산 — DOM을 만들지 않는 부분만 모았다. 렌더러에서는 <script>로, 테스트에서는 import로
// 읽고 둘 다 globalThis.VIEW를 본다(WHENWORK renderer/view.js 방식).
(function (root) {
  const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

  // main/search.mjs의 toChoseong과 같은 구현이어야 한다(view.test가 대조한다). 렌더러는 main
  // 모듈을 import할 수 없어 여기 한 번 더 둔다 — UTF-16 단위 1:1이라 인덱스가 원문과 같다.
  function toChoseong(str) {
    const s = String(str ?? '');
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xac00 && code <= 0xd7a3) out += CHO[Math.floor((code - 0xac00) / 588)];
      else out += s[i];
    }
    return out;
  }

  // 강조 구간 [start, end) 목록. 초성 검색이면 초성열에서 찾아 원문 인덱스로 그대로 쓴다.
  // 겹치는 구간은 합친다 — 겹친 채로 <mark>를 두 번 열면 DOM이 뒤엉킨다.
  function highlightRanges(text, terms, choseong = false) {
    const src = String(text ?? '');
    if (!src || !terms?.length) return [];
    const hay = choseong ? toChoseong(src) : src.toLowerCase();
    const ranges = [];
    for (const raw of terms) {
      const t = choseong ? raw : String(raw).toLowerCase();
      if (!t) continue;
      let from = 0;
      while (from <= hay.length - t.length) {
        const i = hay.indexOf(t, from);
        if (i < 0) break;
        ranges.push([i, i + t.length]);
        from = i + t.length;
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }

  // 텍스트를 강조 구간 기준으로 [{ text, hit }] 조각으로 나눈다 — 그리는 쪽은 hit만 <mark>로 감싼다
  function splitByRanges(text, ranges) {
    const src = String(text ?? '');
    const parts = [];
    let at = 0;
    for (const [s, e] of ranges) {
      if (s > at) parts.push({ text: src.slice(at, s), hit: false });
      parts.push({ text: src.slice(s, e), hit: true });
      at = e;
    }
    if (at < src.length) parts.push({ text: src.slice(at), hit: false });
    return parts.length ? parts : [{ text: '', hit: false }];
  }

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // "방금 · 5분 전 · 3시간 전 · 어제 · 4일 전 · 9월 2일 · 2025년 3월 2일"
  function relativeTime(iso, now = Date.now()) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const diff = now - t;
    if (diff < MIN) return '방금';
    if (diff < HOUR) return `${Math.floor(diff / MIN)}분 전`;
    if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`;
    const days = Math.floor(diff / DAY);
    if (days === 1) return '어제';
    if (days < 7) return `${days}일 전`;
    const d = new Date(t);
    const n = new Date(now);
    return d.getFullYear() === n.getFullYear()
      ? `${d.getMonth() + 1}월 ${d.getDate()}일`
      : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
  }

  root.VIEW = { toChoseong, highlightRanges, splitByRanges, relativeTime };
})(globalThis);
