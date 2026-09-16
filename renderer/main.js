// 메인 창 — 검색창이 곧 입력창(MAIN-01). 왼쪽은 결과, 오른쪽은 편집. 저장 버튼은 없다(MAIN-03).
//
// 전역 함수 runSearch·openNote·closeNote·togglePreview와 state는 스모크 프로브(main/lifecycle.mjs)가
// 부른다 — 이름을 바꾸면 프로브도 함께 바꾼다.
const $ = (id) => document.getElementById(id);
const { pickImage } = window.VIEW;
const els = {
  q: $('q'), tags: $('tags'), create: $('create'), createLabel: $('createLabel'), count: $('count'), list: $('list'),
  placeholder: $('placeholder'), editor: $('editor'), body: $('body'), preview: $('preview'), meta: $('meta'),
  saved: $('saved'), notice: $('notice'), placeholderHotkey: $('placeholderHotkey'), footHotkey: $('footHotkey'),
  undo: $('undo'), undoText: $('undoText'), undoBtn: $('undoBtn'), keymap: $('keymap'), keymapBtn: $('keymapBtn'),
  togglePreview: $('togglePreview'), pin: $('pin'), archive: $('archive'), remove: $('remove'),
  left: document.querySelector('.left'), archToggle: $('archToggle'), order: $('order'),
  settings: $('settings'), hotkeyIn: $('hotkeyIn'), hotkeyHint: $('hotkeyHint'), hotkeyReset: $('hotkeyReset'),
  autostart: $('autostart'), autostartLabel: $('autostartLabel'), autostartHint: $('autostartHint'),
  dataLine: $('dataLine'), dataFile: $('dataFile'), openData: $('openData'), dataHint: $('dataHint'),
  dataExport: $('dataExport'), dataExportMd: $('dataExportMd'), dataImport: $('dataImport'),
  versionLine: $('versionLine'), updateLine: $('updateLine'), updateCheck: $('updateCheck'), updateInstall: $('updateInstall'),
};

const state = {
  q: '',
  query: { terms: [], tags: [], choseong: false },
  results: [],
  sel: -1,
  tags: [],
  note: null, // 열린 메모 { id, body, title, tags, links, backlinks, pinned_at, ... }
  preview: true, // 기본 보기 모드. openNote가 열 때마다 정한다
  dirty: false,
  hotkeyLabel: '',
  archived: false, // 보관함 보기 — 아카이브한 메모만 본다
  hotkeyDefault: '',
};

const SAVE_MS = 400;
let saveTimer = null;
let searchSeq = 0;
let undoTimer = null;

// ── 아이콘 심기
$('searchIco').append(ICONS.search(18));
$('createIco').append(ICONS.plus(14));
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
  const res = await window.whennote.search(q, { archived: state.archived });
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
  const show = plain.length > 0 && !state.query.choseong && !state.archived;
  els.create.hidden = !show;
  if (show) text(els.createLabel, `새 메모 만들기: “${plain}”`);
}

function renderList() {
  els.list.replaceChildren();
  text(els.count, state.results.length ? `${state.results.length}개 메모` : '');
  if (!state.results.length) {
    let msg;
    if (state.archived) msg = state.q.trim() ? '보관함에 일치하는 메모가 없습니다.' : '보관함이 비어 있습니다.\n메모를 열고 보관 버튼을 누르면 여기로 옵니다.';
    else if (state.q.trim()) msg = '일치하는 메모가 없습니다.\nShift+Enter로 이 문장을 새 메모로 만듭니다.';
    else msg = `아직 메모가 없습니다.\n${state.hotkeyLabel || '단축키'}로 어디서든 적거나, 위에 적고 Shift+Enter.`;
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

// ↑↓로 움직이면 그 메모가 바로 오른쫀에 보인다(보기 모드). 열어본 시각은 건드리지 않는다 —
// 훑어보는 동안 목록 순서가 뒤바뀌면 어디를 보고 있었는지 잃는다. 키 반복을 견디게 짧게 디바운스.
let peekTimer = null;
function moveSel(delta) {
  if (!state.results.length) return;
  state.sel = Math.max(0, Math.min(state.results.length - 1, (state.sel < 0 ? 0 : state.sel) + delta));
  for (const [i, row] of [...els.list.children].entries()) row.classList.toggle('sel', i === state.sel);
  els.list.children[state.sel]?.scrollIntoView?.({ block: 'nearest' });
  clearTimeout(peekTimer);
  const id = state.results[state.sel]?.id;
  if (id && state.note?.id !== id) peekTimer = setTimeout(() => openNote(id, { touch: false }), 60);
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
  await openNote(res.id, { edit: true });
  // 커서를 본문 둘째 줄로 — 첫 줄(제목)은 이미 있다
  els.body.value = els.body.value.replace(/\n*$/, '\n');
  els.body.focus();
  els.body.setSelectionRange(els.body.value.length, els.body.value.length);
  markDirty();
}

// ── 편집
// 기본은 보기 모드다 — 메모는 쓰는 횟수보다 다시 읽는 횟수가 많다. 새로 만든 메모(검색어로,
// 퀵캡처 Ctrl+Enter로, 없는 [[링크]]로)는 바로 이어서 적을 것이므로 편집 모드로 연다.
let openSeq = 0;
async function openNote(id, { edit = false, touch = true } = {}) {
  await flushSave();
  const seq = ++openSeq;
  const res = await window.whennote.get(id, { touch });
  if (seq !== openSeq) return; // 그 사이 다른 메모를 열었다(화살표 훑어보기) — 이 결과는 버린다
  if (!res.ok || !res.note) return;
  state.note = res.note;
  state.dirty = false;
  els.body.value = res.note.body;
  els.placeholder.hidden = true;
  els.editor.hidden = false;
  setPreview(!edit);
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
      // 없는 제목이면 그 제목으로 새 메모를 만든다(LINK-02) — 바로 적을 것이므로 편집 모드
      const res = await window.whennote.create(a.dataset.title);
      if (res.ok) await openNote(res.id, { edit: true });
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

// 열린 메모 또는 목록에서 선택한 메모를 지운다. 소프트 삭제라 토스트로 되돌릴 수 있다.
async function removeNote(targetId = state.note?.id) {
  if (!targetId) return;
  const id = targetId;
  const wasOpen = state.note?.id === id;
  const idx = state.results.findIndex((r) => r.id === id);
  if (wasOpen) state.dirty = false; // 지우는 메모의 미뤄둔 저장은 버린다
  await window.whennote.remove(id);
  if (wasOpen) await closeNote();
  else await runSearch();
  // 다음 항목이 선택으로 — 목록에서 연달아 지울 때 커서가 튀지 않게
  if (idx >= 0 && state.results.length) {
    state.sel = Math.min(idx, state.results.length - 1);
    renderList();
  }
  showUndo('삭제했습니다 — 30일 안에는 되돌릴 수 있습니다', async () => {
    await window.whennote.restore(id);
    runSearch();
  });
}

// Shift+↑↓ — 고정한 메모끼리의 순서를 바꾼다(D-10). 고정이 아니면 안내만 한다.
async function moveSelected(dir) {
  const r = state.results[state.sel];
  if (!r) return;
  if (!r.pinned) return flashNotice('고정한 메모만 순서를 바꿀 수 있습니다 — 먼저 고정하세요');
  const res = await window.whennote.move(r.id, dir);
  if (!res.ok || !res.changed) return;
  await runSearch();
  const idx = state.results.findIndex((x) => x.id === r.id);
  if (idx >= 0) {
    state.sel = idx;
    renderList();
  }
}

let noticeTimer = null;
function flashNotice(message, ms = 2500) {
  clearTimeout(noticeTimer);
  text(els.notice, message);
  noticeTimer = setTimeout(() => text(els.notice, ''), ms);
}

// Ctrl+/ — 키맵. `?`는 검색창에서 글자 입력이라 못 쓴다.
function toggleKeymap(force) {
  const on = force ?? els.keymap.hidden;
  els.keymap.hidden = !on;
  if (on) els.settings.hidden = true;
}

// Ctrl+Shift+A — 보관함 보기. 아카이브한 메모만 본다. 새 메모 만들기는 숨긴다.
async function toggleArchived(force) {
  await flushSave();
  state.archived = force ?? !state.archived;
  els.archToggle.classList.toggle('on', state.archived);
  els.left.classList.toggle('archived', state.archived);
  text(els.order, state.archived ? '보관한 메모' : '최근 열어본 순');
  text(els.archToggle, state.archived ? '목록으로' : '보관함');
  state.note = null;
  els.editor.hidden = true;
  els.placeholder.hidden = false;
  await runSearch();
  els.q.focus();
}

// ── 설정 (Ctrl+,)
async function openSettings() {
  els.keymap.hidden = true;
  els.settings.hidden = false;
  await renderSettings();
}

function closeSettings() {
  els.settings.hidden = true;
  els.q.focus();
}

function toggleSettings() {
  return els.settings.hidden ? openSettings() : closeSettings();
}

async function renderSettings() {
  const s = await window.whennote.settingsGet();
  if (!s.ok) return;
  state.hotkeyDefault = s.hotkeyDefault;
  els.hotkeyIn.value = s.hotkeyLabel;
  els.hotkeyHint.className = 'shint' + (s.hotkeyOk ? '' : ' warn');
  text(els.hotkeyHint, s.hotkeyOk
    ? '칸을 누른 뒤 원하는 조합을 누르면 바로 바뀝니다. Ctrl·Alt 중 하나는 들어가야 합니다.'
    : '이 조합은 다른 앱이 쓰고 있어 잡히지 않았습니다 — 칸을 누르고 다른 조합을 누르세요.');
  els.autostart.checked = !!s.openAtLogin;
  text(els.autostartLabel, s.openAtLogin ? '켜짐' : '꺼짐');
  els.autostart.disabled = !s.packaged;
  text(els.autostartHint, s.packaged ? '' : '개발 실행에서는 바꿀 수 없습니다 — 설치본에서만 동작합니다.');
  text(els.dataLine, s.store.ok ? `메모 ${s.store.notes}개 · 저장소 정상` : s.store.notice ?? '저장소를 열지 못했습니다');
  text(els.dataFile, s.store.file);
  text(els.versionLine, `WHENNOTE ${s.version}`);
  renderUpdate(s.update);
}

function renderUpdate(u) {
  text(els.updateLine, u.line ?? '');
  els.updateInstall.hidden = !(u.status === 'ready' || (u.status === 'available' && !u.canAutoUpdate));
  text(els.updateInstall, u.canAutoUpdate ? '지금 설치' : '받는 곳 열기');
}

// KeyboardEvent → Electron 가속기 문자열. 한글 IME 상태와 무관하게 물리 키(code)로 읽는다.
// 수식키만 누른 것, Ctrl·Alt·Super가 하나도 없는 것은 null.
function acceleratorFrom(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;
  const code = e.code || '';
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (code === 'Space') key = 'Space';
  else if (/^Arrow(Up|Down|Left|Right)$/.test(code)) key = code.slice(5);
  else if (['Backspace', 'Delete', 'Tab', 'Enter', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'].includes(code)) key = code === 'Enter' ? 'Return' : code;
  else if (/^Numpad[0-9]$/.test(code)) key = 'num' + code.slice(6);
  else {
    // 기호 키 — Electron이 받는 표기로
    const sym = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`' };
    key = sym[code] ?? null;
  }
  if (!key) return null;
  return [...mods, key].join('+');
}

async function applyHotkey(accel) {
  const res = await window.whennote.hotkeySet(accel);
  if (res.ok) {
    state.hotkeyLabel = res.label;
    els.hotkeyIn.value = res.label;
    els.hotkeyHint.className = 'shint ok';
    text(els.hotkeyHint, `${res.label} 로 바뀌었습니다 — 지금부터 어디서든 이 조합으로 열립니다.`);
    text(els.footHotkey, `${res.label} 퀵 메모`);
    $('keymapHotkey').replaceChildren(el('kbd', null, res.label));
  } else {
    els.hotkeyHint.className = 'shint warn';
    text(els.hotkeyHint, res.error ?? '그 조합은 쓸 수 없습니다');
  }
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
  // 설정의 단축키 칸에 포커스가 있으면 모든 키는 "조합 입력"이다
  if (document.activeElement === els.hotkeyIn) {
    if (e.key === 'Escape' || e.key === 'Tab') {
      els.hotkeyIn.blur();
      if (e.key === 'Escape') e.preventDefault();
      return;
    }
    e.preventDefault();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const accel = acceleratorFrom(e);
    if (!accel) {
      els.hotkeyHint.className = 'shint warn';
      return text(els.hotkeyHint, 'Ctrl 또는 Alt를 함께 눌러야 합니다.');
    }
    return applyHotkey(accel);
  }
  if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    return toggleKeymap();
  }
  if (e.key === ',' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    return toggleSettings();
  }
  if ((e.key === 'A' || e.key === 'a') && e.shiftKey && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    return toggleArchived();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!els.settings.hidden) return closeSettings();
    if (!els.keymap.hidden) return toggleKeymap(false);
    // 목록은 늘 왼쪽에 있으니 "뒤로"가 없다. 본문에서는 검색창으로, 검색창에서는 검색어 지우기, 그다음 창 닫기.
    if (!inSearch) {
      flushSave();
      return els.q.focus();
    }
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
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    return e.shiftKey ? moveSelected(dir) : moveSel(dir);
  }
  if (e.key === 'Delete' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    return removeNote(state.results[state.sel]?.id);
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
els.togglePreview.addEventListener('click', togglePreview);
els.pin.addEventListener('click', togglePin);
els.archive.addEventListener('click', toggleArchive);
els.remove.addEventListener('click', () => removeNote());
els.keymapBtn.addEventListener('click', () => toggleKeymap());
els.archToggle.addEventListener('click', () => toggleArchived());
$('winSettings').addEventListener('click', () => toggleSettings());
els.settings.addEventListener('click', (e) => {
  if (e.target === els.settings) closeSettings();
});
els.hotkeyReset.addEventListener('click', () => applyHotkey(state.hotkeyDefault));
els.autostart.addEventListener('change', async () => {
  const res = await window.whennote.settingsAutostart(els.autostart.checked);
  els.autostart.checked = !!res.openAtLogin;
  text(els.autostartLabel, res.openAtLogin ? '켜짐' : '꺼짐');
  els.autostartHint.className = 'shint' + (res.ok ? '' : ' warn');
  text(els.autostartHint, res.ok ? '' : '켜지 못했습니다 — 시스템 설정의 로그인 항목에서 직접 추가해 주세요.');
});
els.openData.addEventListener('click', () => window.whennote.settingsOpenData());

function dataResult(res, done) {
  els.dataHint.className = 'shint' + (res.ok ? ' ok' : res.canceled ? '' : ' warn');
  if (res.canceled) return text(els.dataHint, '취소했습니다.');
  text(els.dataHint, res.ok ? done.call(null, res) : res.error ?? '실패했습니다');
}
els.dataExport.addEventListener('click', async () => {
  dataResult(await window.whennote.dataExport(), (r) => `메모 ${r.note}개를 내보냈습니다${r.images ? ` · 이미지 ${r.images}개는 옆 attachments/ 폴더에` : ''}.`);
});
els.dataExportMd.addEventListener('click', async () => {
  dataResult(await window.whennote.dataExportMarkdown(), (r) => `메모 ${r.note}개를 .md 파일로 내보냈습니다${r.images ? ` · 이미지 ${r.images}개 포함` : ''}.`);
});
els.dataImport.addEventListener('click', async () => {
  const res = await window.whennote.dataImport();
  dataResult(res, (r) => `메모 ${r.note}개를 가져왔습니다. 직전 데이터는 backups/${r.backup ?? ''} 에 있습니다.`);
  if (res.ok) {
    await renderSettings();
    els.dataHint.className = 'shint ok';
    text(els.dataHint, `메모 ${res.note}개를 가져왔습니다. 직전 데이터는 backups/${res.backup ?? ''} 에 있습니다.`);
    runSearch();
    loadTags();
  }
});

// MAIN-08: 본문에 이미지를 붙이면 파일로 저장하고 커서 자리에 마크다운을 넣는다. 글은 평소대로 붙는다.
els.body.addEventListener('paste', async (e) => {
  if (!state.note) return;
  const blob = pickImage(e.clipboardData);
  if (!blob) return;
  e.preventDefault();
  const bytes = await blob.arrayBuffer();
  const res = await window.whennote.attach(state.note.id, { type: blob.type, bytes });
  if (!res.ok) return flashNotice(res.error ?? '이미지를 붙이지 못했습니다');
  const ta = els.body;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const pad = before && !before.endsWith('\n') ? '\n' : '';
  const insert = `${pad}${res.markdown}\n`;
  ta.value = before + insert + after;
  const cursor = before.length + insert.length;
  ta.setSelectionRange(cursor, cursor);
  markDirty();
  if (res.large) flashNotice('10MB가 넘는 이미지입니다 — 저장은 됐지만 파일이 큽니다', 4000);
});
els.updateCheck.addEventListener('click', async () => {
  text(els.updateLine, '업데이트 확인 중…');
  renderUpdate(await window.whennote.updateCheck());
});
els.updateInstall.addEventListener('click', () => window.whennote.updateInstall());
$('winMin').addEventListener('click', () => window.whennote.minimize());
$('winClose').addEventListener('click', () => {
  flushSave();
  window.whennote.hide();
});
els.keymap.addEventListener('click', (e) => {
  if (e.target === els.keymap) toggleKeymap(false); // 바깥을 누르면 닫힌다
});

// 퀵캡처 저장 등 밖에서 저장소가 바뀌면 목록을 새로 — 편집 중 미저장분은 건드리지 않는다
window.whennote.onChanged(() => {
  runSearch();
  loadTags();
});
// 퀵캡처 Ctrl+Enter로 넘어온 메모 — 이어서 적으러 온 것이니 편집 모드
window.whennote.onOpenNote((id) => openNote(id, { edit: true }));
// 보기 모드에서 본문을 두 번 누르면 편집으로
els.preview.addEventListener('dblclick', (e) => {
  if (e.target.closest?.('a')) return;
  setPreview(false);
});
window.addEventListener('focus', () => {
  if (!state.note) els.q.focus();
});

(async () => {
  const init = await window.whennote.init();
  if (init.ok) {
    state.hotkeyLabel = init.hotkeyLabel;
    text(els.placeholderHotkey, `${init.hotkeyLabel} 로 어디서든 적을 수 있습니다`);
    text(els.footHotkey, `${init.hotkeyLabel} 퀵 메모`);
    $('keymapHotkey').replaceChildren(el('kbd', null, init.hotkeyLabel));
    if (init.notice) text(els.notice, init.notice);
    else if (!init.hotkeyOk) text(els.notice, `단축키 ${init.hotkeyLabel} 등록 실패 — 다른 앱이 쓰고 있습니다`);
    else if (init.store && !init.store.ok) text(els.notice, init.store.notice ?? '저장소를 열지 못했습니다');
  }
  setPreview(true);
  await runSearch('');
  loadTags();
  if (init.ok && init.openNoteId) await openNote(init.openNoteId, { edit: true });
  else els.q.focus();
})();
