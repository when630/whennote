// 메인 창 — 검색창이 곧 입력창(MAIN-01). 왼쪽은 결과, 오른쪽은 편집. 저장 버튼은 없다(MAIN-03).
//
// 전역 함수 runSearch·openNote·closeNote·togglePreview와 state는 스모크 프로브(main/lifecycle.mjs)가
// 부른다 — 이름을 바꾸면 프로브도 함께 바꾼다.
const $ = (id) => document.getElementById(id);
const els = {
  q: $('q'), tags: $('tags'), create: $('create'), createLabel: $('createLabel'), count: $('count'), list: $('list'),
  placeholder: $('placeholder'), editor: $('editor'), body: $('body'), preview: $('preview'), meta: $('meta'),
  saved: $('saved'), notice: $('notice'), hotkeyHint: $('hotkeyHint'), footHotkey: $('footHotkey'),
  undo: $('undo'), undoText: $('undoText'), undoBtn: $('undoBtn'),
  back: $('back'), togglePreview: $('togglePreview'), pin: $('pin'), archive: $('archive'), remove: $('remove'),
};

const state = {
  q: '',
  query: { terms: [], tags: [], choseong: false },
  results: [],
  sel: -1,
  tags: [],
  note: null, // 열린 메모 { id, body, title, tags, links, backlinks, pinned_at, ... }
  preview: false,
  dirty: false,
  hotkeyLabel: '',
};

const SAVE_MS = 400;
let saveTimer = null;
let searchSeq = 0;
let undoTimer = null;

// ── 아이콘 심기
$('searchIco').append(ICONS.search(18));
$('createIco').append(ICONS.plus(14));
els.back.append(ICONS.back(14), document.createTextNode('목록'));
els.pin.append(ICONS.pin(14));
els.archive.append(ICONS.archive(14));
els.remove.append(ICONS.trash(14));

function text(node, value) {
  node.textContent = value;
  return node;
}

function el(tag, cls, content) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (content != null) n.textContent = content;
  return n;
}

// 검색어 일치를 <mark>로 감싼 조각들을 node에 채운다
function fillHighlighted(node, str) {
  const ranges = VIEW.highlightRanges(str, state.query.terms, state.query.choseong);
  for (const p of VIEW.splitByRanges(str, ranges)) {
    node.append(p.hit ? el('mark', null, p.text) : document.createTextNode(p.text));
  }
  return node;
}

// ── 검색
async function runSearch(q = els.q.value) {
  state.q = q;
  const seq = ++searchSeq;
  const res = await window.whennote.search(q);
  if (seq !== searchSeq) return; // 더 새 검색이 이미 나갔다
  if (!res.ok) {
    state.results = [];
    renderList();
    return;
  }
  state.query = res.query;
  state.results = res.items;
  // 열린 메모가 결과에 있으면 그 자리를 선택으로, 아니면 첫 항목
  const openIdx = state.note ? state.results.findIndex((r) => r.id === state.note.id) : -1;
  state.sel = openIdx >= 0 ? openIdx : state.results.length ? 0 : -1;
  renderList();
  renderCreate();
}

function renderCreate() {
  const plain = state.query.terms.join(' ').trim();
  const show = plain.length > 0 && !state.query.choseong;
  els.create.hidden = !show;
  if (show) text(els.createLabel, `새 메모 만들기: “${plain}”`);
}

function renderList() {
  els.list.replaceChildren();
  text(els.count, state.results.length ? `${state.results.length}개 메모` : '');
  if (!state.results.length) {
    const msg = state.q.trim()
      ? '일치하는 메모가 없습니다.\nShift+Enter로 이 문장을 새 메모로 만듭니다.'
      : `아직 메모가 없습니다.\n${state.hotkeyLabel || '단축키'}로 어디서든 적거나, 위에 적고 Shift+Enter.`;
    const e = el('div', 'empty');
    e.style.whiteSpace = 'pre-line';
    e.textContent = msg;
    els.list.append(e);
    return;
  }
  state.results.forEach((r, i) => {
    const row = el('div', 'row' + (i === state.sel ? ' sel' : ''));
    row.dataset.id = r.id;
    const head = el('div', 'head');
    const title = el('div', 'title');
    if (r.pinned) title.append(ICONS.pin(12));
    fillHighlighted(title, r.title);
    head.append(title, el('span', 'when', VIEW.relativeTime(r.opened_at)));
    row.append(head);
    if (r.snippet) row.append(fillHighlighted(el('div', 'snip'), r.snippet));
    if (r.tags.length) {
      const tags = el('div', 'tags');
      for (const t of r.tags) {
        const chip = el('span', 'chip', '#' + t);
        chip.dataset.tag = t;
        tags.append(chip);
      }
      row.append(tags);
    }
    row.addEventListener('click', (e) => {
      const tag = e.target.closest?.('[data-tag]')?.dataset.tag;
      if (tag) return searchTag(tag);
      openNote(r.id);
    });
    els.list.append(row);
  });
  const selected = els.list.children[state.sel];
  selected?.scrollIntoView?.({ block: 'nearest' });
}

function moveSel(delta) {
  if (!state.results.length) return;
  state.sel = Math.max(0, Math.min(state.results.length - 1, (state.sel < 0 ? 0 : state.sel) + delta));
  for (const [i, row] of [...els.list.children].entries()) row.classList.toggle('sel', i === state.sel);
  els.list.children[state.sel]?.scrollIntoView?.({ block: 'nearest' });
}

async function loadTags() {
  const res = await window.whennote.tags();
  state.tags = res.ok ? res.tags : [];
  renderTags();
}

function renderTags() {
  els.tags.replaceChildren();
  const active = new Set(state.query.tags.map((t) => t.toLowerCase()));
  for (const t of state.tags.slice(0, 24)) {
    const chip = el('span', 'chip' + (active.has(t.tag.toLowerCase()) ? ' on' : ''), `#${t.tag}`);
    chip.title = `${t.count}개`;
    chip.addEventListener('click', () => searchTag(t.tag));
    els.tags.append(chip);
  }
}

// 태그 칩을 누르면 검색어에 #태그를 넣거나 뺀다(SRCH-03)
function searchTag(tag) {
  const tok = '#' + tag;
  const parts = els.q.value.split(/\s+/).filter(Boolean);
  const idx = parts.findIndex((p) => p.toLowerCase() === tok.toLowerCase());
  if (idx >= 0) parts.splice(idx, 1);
  else parts.push(tok);
  els.q.value = parts.join(' ');
  els.q.focus();
  runSearch().then(renderTags);
}

// ── 새 메모: 검색어가 첫 줄이 된다(MAIN-01)
async function createFromQuery() {
  const plain = state.query.terms.join(' ').trim() || els.q.value.trim();
  if (!plain) return;
  const res = await window.whennote.create(plain);
  if (!res.ok) return;
  els.q.value = '';
  await runSearch('');
  await openNote(res.id);
  // 커서를 본문 둘째 줄로 — 첫 줄(제목)은 이미 있다
  els.body.value = els.body.value.replace(/\n*$/, '\n');
  els.body.focus();
  els.body.setSelectionRange(els.body.value.length, els.body.value.length);
  markDirty();
}

// ── 편집
async function openNote(id) {
  await flushSave();
  const res = await window.whennote.get(id);
  if (!res.ok || !res.note) return;
  state.note = res.note;
  state.dirty = false;
  els.body.value = res.note.body;
  els.placeholder.hidden = true;
  els.editor.hidden = false;
  setPreview(state.preview);
  renderMeta();
  text(els.saved, '저장됨');
  els.saved.classList.remove('dirty');
  const idx = state.results.findIndex((r) => r.id === id);
  if (idx >= 0) {
    state.sel = idx;
    for (const [i, row] of [...els.list.children].entries()) row.classList.toggle('sel', i === idx);
  }
  if (!state.preview) els.body.focus();
}

async function closeNote() {
  await flushSave();
  state.note = null;
  els.editor.hidden = true;
  els.placeholder.hidden = false;
  els.q.focus();
  // 제목·태그가 바뀌었을 수 있다 — 목록을 새로 그린다
  runSearch();
  loadTags();
}

function renderMeta() {
  const n = state.note;
  els.meta.replaceChildren();
  if (!n) return;
  const add = (node) => els.meta.append(node);
  const dot = () => el('span', 'dot');
  add(el('span', null, `만든 날 ${VIEW.relativeTime(n.created_at)}`));
  add(dot());
  add(el('span', null, `고친 날 ${VIEW.relativeTime(n.updated_at)}`));
  if (n.tags.length) {
    add(dot());
    for (const t of n.tags) {
      const chip = el('span', 'chip', '#' + t);
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', () => searchTag(t));
      add(chip);
    }
  }
  if (n.backlinks.length) {
    add(dot());
    add(el('span', null, `이 메모를 가리키는 곳 ${n.backlinks.length}`));
    for (const b of n.backlinks) {
      const a = el('span', 'backlink', b.title);
      a.addEventListener('click', () => openNote(b.id));
      add(a);
    }
  }
  els.pin.classList.toggle('on', !!n.pinned_at);
  els.pin.title = n.pinned_at ? '고정 해제' : '고정';
  els.archive.classList.toggle('on', !!n.archived_at);
  els.archive.title = n.archived_at ? '아카이브 해제' : '아카이브';
}

function markDirty() {
  state.dirty = true;
  text(els.saved, '저장 중…');
  els.saved.classList.add('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_MS);
}

// 디바운스로 미룬 저장을 지금 한다. 제목이 바뀌었으면 목록도 다시 그린다.
async function flushSave() {
  clearTimeout(saveTimer);
  if (!state.note || !state.dirty) return;
  const id = state.note.id;
  const body = els.body.value;
  const res = await window.whennote.update(id, body);
  if (!state.note || state.note.id !== id) return;
  state.dirty = false;
  if (!res.ok || res.missing) {
    text(els.saved, '저장 실패');
    return;
  }
  state.note.body = body;
  text(els.saved, '저장됨');
  els.saved.classList.remove('dirty');
  if (res.changed) {
    const titleChanged = res.title !== state.note.title;
    state.note.title = res.title;
    state.note.updated_at = res.updated_at;
    // 태그·백링크는 저장소가 다시 계산했다 — 다시 읽어 메타를 맞춘다
    const fresh = await window.whennote.get(id);
    if (fresh.ok && fresh.note && state.note?.id === id) {
      state.note = { ...fresh.note, body };
      renderMeta();
    }
    if (titleChanged) runSearch();
    loadTags();
  }
}

function setPreview(on) {
  state.preview = on;
  els.body.hidden = on;
  els.preview.hidden = !on;
  els.togglePreview.replaceChildren(on ? ICONS.edit(14) : ICONS.eye(14), document.createTextNode(on ? '편집' : '보기'));
  els.togglePreview.classList.toggle('on', on);
  if (on) renderPreview();
  else els.body.focus();
}

function togglePreview() {
  setPreview(!state.preview);
}

function renderPreview() {
  els.preview.replaceChildren(MD.render(els.body.value));
  const byTitle = new Map((state.note?.links ?? []).map((l) => [l.title.toLowerCase(), l.to_id]));
  for (const a of els.preview.querySelectorAll('a.wikilink')) {
    const to = byTitle.get(a.dataset.title.toLowerCase());
    if (!to) a.classList.add('missing');
    a.addEventListener('click', async () => {
      if (to) return openNote(to);
      // 없는 제목이면 그 제목으로 새 메모를 만든다(LINK-02)
      const res = await window.whennote.create(a.dataset.title);
      if (res.ok) {
        await openNote(res.id);
        setPreview(false);
      }
    });
  }
  for (const a of els.preview.querySelectorAll('a.tag')) {
    a.addEventListener('click', () => searchTag(a.dataset.tag));
  }
}

// ── 고정·아카이브·삭제
async function togglePin() {
  if (!state.note) return;
  const on = !state.note.pinned_at;
  await window.whennote.setPinned(state.note.id, on);
  state.note.pinned_at = on ? new Date().toISOString() : null;
  renderMeta();
  runSearch();
}

async function toggleArchive() {
  if (!state.note) return;
  const on = !state.note.archived_at;
  const id = state.note.id;
  await window.whennote.setArchived(id, on);
  if (on) {
    await closeNote();
    showUndo('아카이브했습니다', async () => {
      await window.whennote.setArchived(id, false);
      runSearch();
    });
  } else {
    state.note.archived_at = null;
    renderMeta();
    runSearch();
  }
}

async function removeNote() {
  if (!state.note) return;
  const id = state.note.id;
  state.dirty = false; // 지우는 메모의 미뤄둔 저장은 버린다
  await window.whennote.remove(id);
  await closeNote();
  showUndo('삭제했습니다 — 30일 안에는 되돌릴 수 있습니다', async () => {
    await window.whennote.restore(id);
    runSearch();
  });
}

function showUndo(message, onUndo) {
  clearTimeout(undoTimer);
  text(els.undoText, message);
  els.undo.hidden = false;
  els.undoBtn.onclick = async () => {
    els.undo.hidden = true;
    await onUndo.call(null);
  };
  undoTimer = setTimeout(() => {
    els.undo.hidden = true;
  }, 8000);
}

// ── 키보드
els.q.addEventListener('input', () => runSearch().then(renderTags));
document.addEventListener('keydown', (e) => {
  const inSearch = document.activeElement === els.q;
  const inBody = document.activeElement === els.body;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (state.note) return closeNote();
    if (els.q.value) {
      els.q.value = '';
      return runSearch().then(renderTags);
    }
    return window.whennote.hide();
  }
  if (e.key === 'e' && (e.ctrlKey || e.metaKey) && state.note) {
    e.preventDefault();
    return togglePreview();
  }
  if (inBody) return; // 본문 편집 중에는 아래 목록 단축키를 가로채지 않는다
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    return moveSel(e.key === 'ArrowDown' ? 1 : -1);
  }
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    return createFromQuery();
  }
  if (e.key === 'Enter' && inSearch) {
    e.preventDefault();
    const r = state.results[state.sel];
    if (r) return openNote(r.id);
    return createFromQuery();
  }
});
els.body.addEventListener('input', markDirty);
els.body.addEventListener('blur', () => flushSave());
els.create.addEventListener('click', createFromQuery);
els.back.addEventListener('click', closeNote);
els.togglePreview.addEventListener('click', togglePreview);
els.pin.addEventListener('click', togglePin);
els.archive.addEventListener('click', toggleArchive);
els.remove.addEventListener('click', removeNote);

// 퀵캡처 저장 등 밖에서 저장소가 바뀌면 목록을 새로 — 편집 중 미저장분은 건드리지 않는다
window.whennote.onChanged(() => {
  runSearch();
  loadTags();
});
window.whennote.onOpenNote((id) => openNote(id));
window.addEventListener('focus', () => {
  if (!state.note) els.q.focus();
});

(async () => {
  const init = await window.whennote.init();
  if (init.ok) {
    state.hotkeyLabel = init.hotkeyLabel;
    text(els.hotkeyHint, `${init.hotkeyLabel} 로 어디서든 적을 수 있습니다`);
    text(els.footHotkey, `${init.hotkeyLabel} 퀵 메모`);
    if (init.notice) text(els.notice, init.notice);
    else if (!init.hotkeyOk) text(els.notice, `단축키 ${init.hotkeyLabel} 등록 실패 — 다른 앱이 쓰고 있습니다`);
    else if (init.store && !init.store.ok) text(els.notice, init.store.notice ?? '저장소를 열지 못했습니다');
  }
  setPreview(false);
  await runSearch('');
  loadTags();
  if (init.ok && init.openNoteId) await openNote(init.openNoteId);
  else els.q.focus();
})();
