import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAttachments, isSafeName, WARN_BYTES } from '../main/attachments.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whennote-a-'));

test('save는 UUID.확장자 이름으로 쓰고 resolve로 다시 찾는다', () => {
  const a = createAttachments(path.join(tmp(), 'attachments'));
  const r = a.save(Buffer.from([1, 2, 3]), 'png');
  assert.ok(isSafeName(r.file));
  assert.equal(r.bytes, 3);
  assert.equal(r.large, false);
  assert.ok(fs.existsSync(a.resolve(r.file)));
  assert.deepEqual(a.list(), [r.file]);
});

test('resolve는 이름 규칙에 맞지 않거나 폴더를 벗어나는 것을 거절한다 — 경로 탈출 방지', () => {
  const a = createAttachments(path.join(tmp(), 'attachments'));
  for (const bad of ['../store.sqlite', 'x.png', '11111111-1111-4111-8111-111111111111.png/..', 'C:\\x.png', '']) {
    assert.equal(a.resolve(bad), null, bad);
  }
});

test('ArrayBuffer도 받고, 10MB를 넘으면 large로 알린다 (D-08)', () => {
  const a = createAttachments(path.join(tmp(), 'attachments'));
  const big = new Uint8Array(WARN_BYTES + 1);
  const r = a.save(big.buffer, 'jpg');
  assert.equal(r.large, true);
  assert.equal(fs.statSync(a.resolve(r.file)).size, WARN_BYTES + 1);
});

test('remove는 있는 것만 지우고 개수를 돌려준다', () => {
  const a = createAttachments(path.join(tmp(), 'attachments'));
  const r = a.save(Buffer.from('x'), 'png');
  assert.equal(a.remove([r.file, '../evil', 'nope.png']), 1);
  assert.deepEqual(a.list(), []);
});

test('copyTo → importFrom 왕복. 이미 있는 파일은 덮지 않는다', () => {
  const src = createAttachments(path.join(tmp(), 'attachments'));
  const r1 = src.save(Buffer.from('one'), 'png');
  const r2 = src.save(Buffer.from('two'), 'gif');
  const exportDir = tmp();
  assert.equal(src.copyTo([r1.file, r2.file, 'missing.png'], exportDir), 2);
  fs.writeFileSync(path.join(exportDir, 'attachments', 'not-safe.txt'), 'x'); // 규칙에 안 맞는 파일은 무시돼야 한다

  const dst = createAttachments(path.join(tmp(), 'attachments'));
  fs.writeFileSync(path.join(dst.dir, r1.file), 'already'); // 먼저 있던 파일
  assert.equal(dst.importFrom(exportDir), 1);
  assert.equal(fs.readFileSync(dst.resolve(r1.file), 'utf8'), 'already', '있는 파일을 덮지 않는다');
  assert.equal(fs.readFileSync(dst.resolve(r2.file), 'utf8'), 'two');
  assert.deepEqual(dst.list().sort(), [r1.file, r2.file].sort());
});

test('listOlderThan은 mtime이 오래된 것만 — 방금 붙인 파일은 고아 정리에서 빠진다', () => {
  const a = createAttachments(path.join(tmp(), 'attachments'));
  const fresh = a.save(Buffer.from('f'), 'png');
  const old = a.save(Buffer.from('o'), 'png');
  const past = new Date(Date.now() - 3 * 86400_000);
  fs.utimesSync(a.resolve(old.file), past, past);
  assert.deepEqual(a.listOlderThan(86400_000), [old.file]);
  assert.ok(!a.listOlderThan(86400_000).includes(fresh.file));
});
