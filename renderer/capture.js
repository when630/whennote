// 퀵 메모 — 저장 버튼이 없다(CAP-02). Esc·blur·창 닫기·단축키 재입력이 모두 "저장하고 닫기"다.
// Enter는 언제나 줄바꿈이다(D-05). 메인 프로세스는 본문을 갖고 있지 않으므로 닫아야 할 때
// capture:flush를 보내고, 여기서 저장한 뒤 hide()를 부른다.
const input = document.getElementById('in');
const msg = document.getElementById('msg');
const pinBtn = document.getElementById('pin');
const closeBtn = document.getElementById('close');
let busy = false;
let pinned = false;
let msgTimer = null;

function showMsg(kind, text, holdMs = 0) {
  clearTimeout(msgTimer);
  msg.className = 'msg' + (kind ? ' ' + kind : '');
  msg.textContent = text;
  if (holdMs) msgTimer = setTimeout(() => { msg.className = 'msg'; msg.textContent = ''; }, holdMs);
}

// 저장하고 닫는다. 비어 있으면 아무것도 만들지 않고 닫기만 한다.
async function flush() {
  if (busy) return;
  busy = true;
  try {
    const body = input.value;
    if (body.trim()) {
      const res = await window.whennote.save(body);
      if (res.ok) input.value = '';
    }
    window.whennote.hide();
  } finally {
    busy = false;
  }
}

// 저장하고 메인 창에서 이어서 편집한다. 빈 본문이면 메인 창만 연다.
async function openInMain() {
  if (busy) return;
  busy = true;
  try {
    const res = await window.whennote.openInMain(input.value);
    if (res.ok) input.value = '';
  } finally {
    busy = false;
  }
}

async function togglePin() {
  const res = await window.whennote.pin(!pinned);
  pinned = !!res.pinned;
  pinBtn.classList.toggle('on', pinned);
  showMsg('', pinned ? '항상 위 — 다른 창을 눌러도 남습니다' : '', pinned ? 2500 : 0);
}

window.whennote.onReset(() => {
  busy = false;
  showMsg('', '');
  input.focus();
});
window.whennote.onFlush(() => flush());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    return flush();
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    return openInMain();
  }
});

pinBtn.addEventListener('click', togglePin);
closeBtn.addEventListener('click', flush);
window.addEventListener('focus', () => input.focus());
input.focus();
