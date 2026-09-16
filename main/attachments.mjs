// main/attachments.mjs — 첨부 파일 폴더(STOR-04). store.sqlite 옆 attachments/ 에 이미지가 놓인다.
// 파일명은 UUID + 확장자 하나뿐이라 본문의 `![..](attachments/<이름>)`이 곧 참조다. Electron을
// import하지 않는 순수 Node 모듈이라 node --test로 검증한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ATTACH_DIR = 'attachments';
export const WARN_BYTES = 10 * 1024 * 1024; // D-08: 넘으면 저장은 하되 경고만

const SAFE_NAME = /^[a-f0-9-]{36}\.[a-z0-9]{1,5}$/;

export function isSafeName(name) {
  return SAFE_NAME.test(String(name));
}

// 바이트 앞머리로 이미지 형식을 알아낸다. 클립보드가 알려주는 MIME은 앱마다 제각각이라
// (image/x-png, 빈 문자열, 파일 항목 등) 이름을 믿지 않고 내용을 본다. 모르면 null.
export function sniffImageExt(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}

export function createAttachments(dir) {
  fs.mkdirSync(dir, { recursive: true });

  // bytes: Buffer|Uint8Array|ArrayBuffer. 돌려주는 file은 폴더 안 이름(경로 아님).
  function save(bytes, ext) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
    const file = `${crypto.randomUUID()}.${String(ext).toLowerCase()}`;
    fs.writeFileSync(path.join(dir, file), buf);
    return { file, bytes: buf.length, large: buf.length > WARN_BYTES };
  }

  // 이름 하나 → 절대 경로. 폴더 밖을 가리키는 이름은 null(경로 탈출 방지).
  function resolve(name) {
    if (!isSafeName(name)) return null;
    const full = path.join(dir, name);
    return path.dirname(full) === dir ? full : null;
  }

  function remove(names) {
    let removed = 0;
    for (const n of names ?? []) {
      const full = resolve(n);
      if (!full) continue;
      try {
        fs.unlinkSync(full);
        removed += 1;
      } catch {
        // 이미 없으면 그만
      }
    }
    return removed;
  }

  function list() {
    try {
      return fs.readdirSync(dir).filter(isSafeName);
    } catch {
      return [];
    }
  }

  // olderThanMs보다 오래된 것만 — 붙여 놓고 아직 저장하지 않은 퀵캡처의 이미지를 치우지 않기 위해
  function listOlderThan(olderThanMs, now = Date.now()) {
    return list().filter((n) => {
      try {
        return now - fs.statSync(path.join(dir, n)).mtimeMs > olderThanMs;
      } catch {
        return false;
      }
    });
  }

  // 내보내기: 이름들을 dest/attachments/ 로 복사. 없는 원본은 건너뛴다.
  function copyTo(names, destRoot) {
    const out = path.join(destRoot, ATTACH_DIR);
    let copied = 0;
    for (const n of names ?? []) {
      const src = resolve(n);
      if (!src || !fs.existsSync(src)) continue;
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(src, path.join(out, n));
      copied += 1;
    }
    return copied;
  }

  // 가져오기: srcRoot/attachments/ 의 안전한 이름만 들여온다. 이미 있는 파일은 덮지 않는다.
  function importFrom(srcRoot) {
    const from = path.join(srcRoot, ATTACH_DIR);
    let imported = 0;
    let files;
    try {
      files = fs.readdirSync(from).filter(isSafeName);
    } catch {
      return 0;
    }
    for (const n of files) {
      const dest = path.join(dir, n);
      if (fs.existsSync(dest)) continue;
      try {
        fs.copyFileSync(path.join(from, n), dest);
        imported += 1;
      } catch {
        // 한 파일 실패가 나머지를 막지 않는다
      }
    }
    return imported;
  }

  return { dir, save, resolve, remove, list, listOlderThan, copyTo, importFrom };
}
