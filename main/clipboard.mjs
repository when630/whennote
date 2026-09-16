// main/clipboard.mjs — 클립보드 어댑터(오픈이슈 #5의 (b)). Electron 43.7.1의 clipboard.readText()는
// 동기이고 readImage·availableFormats가 있지만, 문서 main 브랜치의 breaking-changes에는 readText가
// Promise를 돌려주고 readImage가 clipboard.read()+MIME로 바뀌는 계획이 적혀 있다. 호출부가 그 세대
// 교체를 모르게 하려고 여기 한 파일에서만 clipboard를 만지고, 모든 함수를 async로 둔다 —
// 지금 값이 문자열이든 Promise든 await 한 번으로 같아진다.
import { clipboard } from 'electron';

const IMAGE_EXT = {
  'image/png': 'png', 'image/x-png': 'png', 'image/apng': 'png',
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/x-bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
};

export async function readText() {
  try {
    return String((await clipboard.readText()) ?? '');
  } catch {
    return '';
  }
}

// 클립보드에 이미지가 있는가. availableFormats가 사라진 세대에서는 readImage로 판단한다.
export async function hasImage() {
  try {
    if (typeof clipboard.availableFormats === 'function') {
      const formats = await clipboard.availableFormats();
      if (Array.isArray(formats)) return formats.some((f) => String(f).startsWith('image/'));
    }
    const img = await clipboard.readImage();
    return !!img && !img.isEmpty();
  } catch {
    return false;
  }
}

// 이미지를 PNG 바이트로. 없으면 null.
export async function readImagePng() {
  try {
    const img = await clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    return img.toPNG();
  } catch {
    return null;
  }
}

export function extensionFor(mime) {
  return IMAGE_EXT[String(mime ?? '').toLowerCase().split(';')[0].trim()] ?? null;
}

const URL_RE = /^https?:\/\/\S+$/i;
const PREVIEW_MAX = 60;

// 퀵캡처 창이 열릴 때 보여줄 한 줄 제안(CAP-07). 붙이지 않고 보여만 준다.
//   { kind: 'image' } | { kind: 'url' | 'text', preview } | null
export async function peek() {
  if (await hasImage()) return { kind: 'image' };
  const text = (await readText()).trim();
  if (!text) return null;
  if (URL_RE.test(text)) return { kind: 'url', preview: text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '…' : text };
  const first = text.split('\n')[0].trim();
  return { kind: 'text', preview: first.length > PREVIEW_MAX ? first.slice(0, PREVIEW_MAX) + '…' : first };
}
