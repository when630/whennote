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

// CAP-07: 창이 열릴 때 클립보드를 한 번 들여다보고 한 줄 제안한다. 붙이지는 않는다 —
// 사용자가 Ctrl+V를 누르면 textarea가 평소처럼 붙인다. 이미지는 메인 창에서만 붙일 수 있다(MAIN-08).
const clipBox = document.getElementById('clip');
const clipLabel = document.getElementById('clipLabel');
const clipPrev = document.getElementById('clipPrev');
const clipKey = document.getElementById('clipKey');
const clipIco = document.getElementById('clipIco');
clipIco.append(ICONS.clipboard(15));

async function suggestClipboard() {
  clipBox.hidden = true;
  if (input.value.trim()) return; // 이미 적고 있으면 방해하지 않는다
  const res = await window.whennote.clipboardPeek();
  const peek = res?.peek;
  if (!peek) return;
  if (peek.kind === 'image') {
    clipLabel.textContent = '클립보드에 이미지가 있어요';
    clipPrev.textContent = '메인 창에서 열면 Ctrl+V로 붙일 수 있습니다';
    clipKey.textContent = 'Ctrl ↵';
  } else {
    clipLabel.textContent = peek.kind === 'url' ? '클립보드에 링크가 있어요' : '클립보드에 글이 있어요';
    clipPrev.textContent = peek.preview;
    clipKey.textContent = 'Ctrl V';
  }
  clipBox.hidden = false;
}

window.whennote.onReset(() => {
  busy = false;
  showMsg('', '');
  input.focus();
  suggestClipboard();
});
input.addEventListener('input', () => {
  clipBox.hidden = true; // 적기 시작하면 제안은 사라진다
});
suggestClipboard();
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
