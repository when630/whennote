// 최소 마크다운(MAIN-04). parse는 순수 함수(블록 배열)라 검증하기 쉽고, DOM은 render가 만든다(innerHTML 쓰지 않음).
// WHENWORK renderer/md.js에서 출발해 메모용으로 넓혔다.
//
// 블록: 제목(#~####) · 목록(-,*,1.)과 중첩(들여쓰기 2칸) · 체크박스(- [ ] / - [x]) · 인용(>) · 코드 블록(```) · 구분선(---) · 문단
// 인라인: ![이미지](attachments/…) · `코드` · **굵게** · ~~취소~~ · *기울임* · _기울임_ · [글](https://…) · [[메모 링크]] · https://… · #태그
(function () {
  const INLINE_RE = new RegExp(
    [
      '(!\\[[^\\]\\n]*\\]\\([^)\\s]+\\))', // 1 이미지
      '(`[^`\\n]+`)', // 2 코드
      '(\\*\\*[^*\\n]+?\\*\\*)', // 3 굵게
      '(~~[^~\\n]+?~~)', // 4 취소선
      '(\\*[^*\\s][^*\\n]*?\\*)', // 5 기울임 *
      '((?:^|(?<=[^\\p{L}\\p{N}_]))_[^_\\s][^_\\n]*?_(?=$|[^\\p{L}\\p{N}_]))', // 6 기울임 _ (단어 경계에서만 — snake_case를 건드리지 않게)
      '(\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^)\\s]+\\))', // 7 외부 링크
      '(\\[\\[[^\\[\\]\\n]+?\\]\\])', // 8 메모 링크
      '(https?:\\/\\/[^\\s<>()\\[\\]]+)', // 9 URL 그대로
      '((?:^|(?<=[^\\p{L}\\p{N}_#]))#[\\p{L}\\p{N}_][\\p{L}\\p{N}_-]*)', // 10 태그
    ].join('|'),
    'gu'
  );
  // 첨부 폴더 안의 이름만 그림으로 보여준다(D-11). 그 외 경로는 글자 그대로 — CSP가 어차피 막는다.
  const ATTACH_RE = /^attachments\/([a-f0-9-]{36}\.[a-z0-9]{1,5})$/;
  // URL 끝에 붙은 문장부호는 링크가 아니다 — "https://a.b/c." 의 마지막 점
  const URL_TRAIL = /[.,;:!?'"]+$/;

  function inline(text) {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(INLINE_RE)) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index) });
      let consumed = m[0].length;
      if (m[1]) {
        const im = m[1].match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        const att = im[2].match(ATTACH_RE);
        if (att) parts.push({ text: im[1] || '이미지', kind: 'image', file: att[1] });
        else parts.push({ text: m[1] });
      } else if (m[2]) parts.push({ text: m[2].slice(1, -1), kind: 'code' });
      else if (m[3]) parts.push({ text: m[3].slice(2, -2), kind: 'bold' });
      else if (m[4]) parts.push({ text: m[4].slice(2, -2), kind: 'strike' });
      else if (m[5] || m[6]) parts.push({ text: (m[5] || m[6]).slice(1, -1), kind: 'italic' });
      else if (m[7]) {
        const lm = m[7].match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        parts.push({ text: lm[1], kind: 'url', href: lm[2] });
      } else if (m[8]) parts.push({ text: m[8].slice(2, -2).trim(), kind: 'link' });
      else if (m[9]) {
        const trail = m[9].match(URL_TRAIL)?.[0] ?? '';
        const href = trail ? m[9].slice(0, -trail.length) : m[9];
        parts.push({ text: href, kind: 'url', href });
        consumed -= trail.length; // 문장부호는 다음 글자로 돌려준다
      } else if (m[10]) {
        const tag = m[10].slice(1);
        if (/^\d+$/.test(tag)) parts.push({ text: m[10] }); // #201은 태그가 아니다
        else parts.push({ text: m[10], kind: 'tag', tag });
      }
      last = m.index + consumed;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts.length ? parts : [{ text: '' }];
  }

  const LIST_RE = /^(\s*)([-*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
  const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

  // 블록 목록. 목록은 { type:'list', items:[{ parts, depth, ordered, checked, line }] } — 같은 깊이의 연속 항목이
  // 한 블록이고, 깊이가 달라지는 건 render가 중첩으로 그린다. line은 원문 줄 번호(체크박스 토글이 그 줄을 고친다).
  function parse(src) {
    const blocks = [];
    let list = null;
    let code = null;
    const flush = () => {
      if (list) blocks.push(list);
      list = null;
    };

    const lines = String(src ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (code) {
        if (/^\s*```/.test(raw)) {
          blocks.push(code);
          code = null;
        } else code.lines.push(raw);
        continue;
      }
      const line = raw.trimEnd();
      if (/^\s*```/.test(line)) {
        flush();
        code = { type: 'code', lang: line.replace(/^\s*```/, '').trim(), lines: [] };
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      if (HR_RE.test(line)) {
        flush();
        blocks.push({ type: 'hr' });
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flush();
        blocks.push({ type: 'heading', level: heading[1].length, parts: inline(heading[2]) });
        continue;
      }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flush();
        blocks.push({ type: 'quote', parts: inline(quote[1]) });
        continue;
      }
      const item = line.match(LIST_RE);
      if (item) {
        if (!list) list = { type: 'list', items: [] };
        list.items.push({
          parts: inline(item[4]),
          depth: Math.floor(item[1].replace(/\t/g, '  ').length / 2),
          ordered: /^\d/.test(item[2]),
          checked: item[3] == null ? null : item[3] !== ' ',
          line: i,
        });
        continue;
      }
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev?.type === 'para') prev.parts.push({ text: ' ' }, ...inline(line));
      else blocks.push({ type: 'para', parts: inline(line) });
    }
    if (code) blocks.push(code); // 닫히지 않은 코드 블록도 그대로 보여준다
    flush();
    return blocks;
  }

  function fill(node, parts) {
    for (const p of parts) {
      if (p.kind === 'bold') node.append(Object.assign(document.createElement('strong'), { textContent: p.text }));
      else if (p.kind === 'italic') node.append(Object.assign(document.createElement('em'), { textContent: p.text }));
      else if (p.kind === 'strike') node.append(Object.assign(document.createElement('s'), { textContent: p.text }));
      else if (p.kind === 'code') node.append(Object.assign(document.createElement('code'), { textContent: p.text }));
      else if (p.kind === 'link') {
        const a = document.createElement('a');
        a.className = 'wikilink';
        a.dataset.title = p.text;
        a.textContent = p.text;
        node.append(a);
      } else if (p.kind === 'url') {
        const a = document.createElement('a');
        a.className = 'ext';
        a.href = p.href;
        a.title = p.href;
        a.textContent = p.text;
        node.append(a);
      } else if (p.kind === 'tag') {
        const s = document.createElement('a');
        s.className = 'tag';
        s.dataset.tag = p.tag;
        s.textContent = p.text;
        node.append(s);
      } else if (p.kind === 'image') {
        const img = document.createElement('img');
        img.src = 'wn-attach://files/' + p.file;
        img.alt = p.text;
        img.loading = 'lazy';
        node.append(img);
      } else {
        node.append(document.createTextNode(p.text));
      }
    }
    return node;
  }

  // 항목 깊이를 따라 ul/ol을 겹쳐 그린다. 깊이가 한 번에 둘 이상 뛰어도 한 단계씩만 판다.
  function renderList(block) {
    const root = document.createElement(block.items[0]?.ordered ? 'ol' : 'ul');
    const stack = [{ el: root, depth: 0 }];
    let lastLi = null;
    for (const it of block.items) {
      const depth = Math.min(it.depth, stack[stack.length - 1].depth + 1);
      while (stack.length > 1 && stack[stack.length - 1].depth > depth) stack.pop();
      if (depth > stack[stack.length - 1].depth) {
        const sub = document.createElement(it.ordered ? 'ol' : 'ul');
        (lastLi ?? stack[stack.length - 1].el).append(sub);
        stack.push({ el: sub, depth });
      }
      const li = document.createElement('li');
      if (it.checked !== null) {
        li.className = 'task' + (it.checked ? ' done' : '');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = it.checked;
        box.dataset.line = String(it.line);
        li.append(box, fill(document.createElement('span'), it.parts));
      } else fill(li, it.parts);
      stack[stack.length - 1].el.append(li);
      lastLi = li;
    }
    return root;
  }

  function render(src) {
    const frag = document.createDocumentFragment();
    for (const block of parse(src)) {
      if (block.type === 'heading') {
        frag.append(fill(document.createElement(`h${Math.min(block.level + 1, 6)}`), block.parts));
      } else if (block.type === 'list') {
        frag.append(renderList(block));
      } else if (block.type === 'quote') {
        frag.append(fill(document.createElement('blockquote'), block.parts));
      } else if (block.type === 'hr') {
        frag.append(document.createElement('hr'));
      } else if (block.type === 'code') {
        const pre = document.createElement('pre');
        const c = document.createElement('code');
        if (block.lang) c.dataset.lang = block.lang;
        c.textContent = block.lines.join('\n');
        pre.append(c);
        frag.append(pre);
      } else {
        frag.append(fill(document.createElement('p'), block.parts));
      }
    }
    return frag;
  }

  // 원문 line번째 줄의 체크박스를 뒤집은 새 원문. 그 줄이 체크박스 항목이 아니면 원문 그대로.
  function toggleTask(src, line) {
    const lines = String(src ?? '').split('\n');
    const m = lines[line]?.match(/^(\s*(?:[-*]|\d+[.)])\s+\[)([ xX])(\]\s.*)$/);
    if (!m) return src;
    lines[line] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3];
    return lines.join('\n');
  }

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.MD = { parse, inline, render, toggleTask };
})();
