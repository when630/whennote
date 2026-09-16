// 최소 마크다운(MAIN-04) — 제목·강조·목록·인용·인라인 코드·코드 블록·[[링크]]·#태그.
// 체크박스 문법은 특별 취급하지 않는다(할 일은 WHENWORK의 것). parse는 순수 함수(블록 배열)라
// 검증하기 쉽고, DOM은 render가 만든다(innerHTML 쓰지 않음). WHENWORK renderer/md.js에서 출발.
(function () {
  // 인라인: `코드` · **굵게** · [[링크]] · #태그 → [{ text, kind }]
  const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[\[[^\[\]\n]+?\]\])|((?:^|(?<=[^\p{L}\p{N}_#]))#[\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu;

  function inline(text) {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(INLINE_RE)) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index) });
      if (m[1]) parts.push({ text: m[1].slice(1, -1), kind: 'code' });
      else if (m[2]) parts.push({ text: m[2].slice(2, -2), kind: 'bold' });
      else if (m[3]) parts.push({ text: m[3].slice(2, -2).trim(), kind: 'link' });
      else if (m[4]) {
        const tag = m[4].slice(1);
        if (/^\d+$/.test(tag)) parts.push({ text: m[4] }); // #201은 태그가 아니다
        else parts.push({ text: m[4], kind: 'tag', tag });
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts.length ? parts : [{ text: '' }];
  }

  function parse(src) {
    const blocks = [];
    let list = null;
    let code = null;
    const flush = () => {
      if (list) blocks.push(list);
      list = null;
    };

    for (const raw of String(src ?? '').split('\n')) {
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
      const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
      if (item) {
        const ordered = /^\s*\d/.test(line);
        if (!list || list.ordered !== ordered) {
          flush();
          list = { type: 'list', ordered, items: [] };
        }
        list.items.push(inline(item[1]));
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
      if (p.kind === 'bold') {
        const b = document.createElement('strong');
        b.textContent = p.text;
        node.append(b);
      } else if (p.kind === 'code') {
        const c = document.createElement('code');
        c.textContent = p.text;
        node.append(c);
      } else if (p.kind === 'link') {
        const a = document.createElement('a');
        a.className = 'wikilink';
        a.dataset.title = p.text;
        a.textContent = p.text;
        node.append(a);
      } else if (p.kind === 'tag') {
        const s = document.createElement('a');
        s.className = 'tag';
        s.dataset.tag = p.tag;
        s.textContent = p.text;
        node.append(s);
      } else {
        node.append(document.createTextNode(p.text));
      }
    }
    return node;
  }

  function render(src) {
    const frag = document.createDocumentFragment();
    for (const block of parse(src)) {
      if (block.type === 'heading') {
        frag.append(fill(document.createElement(`h${Math.min(block.level + 1, 6)}`), block.parts));
      } else if (block.type === 'list') {
        const ul = document.createElement(block.ordered ? 'ol' : 'ul');
        for (const item of block.items) ul.append(fill(document.createElement('li'), item));
        frag.append(ul);
      } else if (block.type === 'quote') {
        frag.append(fill(document.createElement('blockquote'), block.parts));
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

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.MD = { parse, inline, render };
})();
