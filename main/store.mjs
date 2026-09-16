// main/store.mjs — node:sqlite 기반 단일 파일 저장소. 열기·손상 판정·마이그레이션·백업 체계는
// WHENWORK main/store.mjs(34d5f3b)에서 그대로 가져왔고(D-12~D-17 승계), 스키마와 CRUD만 메모용이다.
//
// 캡처는 큐에 먼저 남고(main/queue.mjs), 여기서는 그 뒤 즉시 반영만 맡는다. DatabaseSync는 동기
// API라 이 파일의 모든 함수도 동기다. Electron을 import하지 않는 순수 Node 모듈이라 node --test로
// 검증한다.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toChoseong, parseQuery, splitTerms, ftsMatch, likePattern, makeSnippet } from './search.mjs';
import { titleOf, extractTags, extractLinks } from './links.mjs';
import { EXPORT_VERSION, validateExport } from './export.mjs';

// 앱이 자신보다 높은 user_version의 DB를 만나면 열지 않는다(STOR-03) — 구버전으로 되돌린
// 사용자가 최신 스키마에 실수로 쓰지 않게 막는 신호다.
export class NewerSchemaError extends Error {
  constructor(found, known) {
    super(`store schema v${found}, this app only knows up to v${known}`);
    this.name = 'NewerSchemaError';
    this.found = found;
    this.known = known;
  }
}

// v1 스키마(03_기술_스펙 §4).
//
// note.rid — FTS5 external-content 표는 rowid로 본문 표와 짝을 맞춘다. TEXT PRIMARY KEY만 있는
// 표의 암묵적 rowid는 VACUUM에서 바뀔 수 있어 색인이 어긋난다. 그래서 정수 PK를 따로 두고
// id(UUID)는 UNIQUE로 건다 — INSERT OR IGNORE의 멱등 키는 여전히 id다.
//
// 트리거 셋은 FTS5 문서의 external-content 표준 패턴이다. UPDATE는 옛 값 delete + 새 값 insert.
const V1_SQL = `
CREATE TABLE note (
  rid         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  body        TEXT NOT NULL,
  title       TEXT NOT NULL,
  title_cho   TEXT NOT NULL,
  body_cho    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  opened_at   TEXT NOT NULL,
  pinned_at   TEXT,
  archived_at TEXT,
  deleted_at  TEXT
);
CREATE INDEX note_opened ON note (opened_at DESC);
CREATE INDEX note_title ON note (title COLLATE NOCASE);
CREATE VIRTUAL TABLE note_fts USING fts5(
  title, body, content='note', content_rowid='rid', tokenize='trigram'
);
CREATE TRIGGER note_ai AFTER INSERT ON note BEGIN
  INSERT INTO note_fts(rowid, title, body) VALUES (new.rid, new.title, new.body);
END;
CREATE TRIGGER note_ad AFTER DELETE ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, title, body) VALUES ('delete', old.rid, old.title, old.body);
END;
CREATE TRIGGER note_au AFTER UPDATE OF title, body ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, title, body) VALUES ('delete', old.rid, old.title, old.body);
  INSERT INTO note_fts(rowid, title, body) VALUES (new.rid, new.title, new.body);
END;
CREATE TABLE note_tag (
  note_id TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX note_tag_tag ON note_tag (tag);
CREATE TABLE note_link (
  from_id  TEXT NOT NULL,
  to_id    TEXT,
  to_title TEXT NOT NULL,
  PRIMARY KEY (from_id, to_title)
);
CREATE INDEX note_link_to ON note_link (to_id);
CREATE TABLE attachment (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL,
  file       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE event (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  kind   TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX event_at ON event (at DESC);
`;

// v2 — 고정한 메모끼리의 순서(D-10). 고정 안 된 메모는 최근 열어본 순이 그대로이고(D-03),
// 고정 그룹 안에서만 Shift+↑↓로 자리를 바꾼다. 이미 고정된 메모는 고정한 순서대로 번호를 받는다.
const V2_SQL = `
ALTER TABLE note ADD COLUMN pin_order INTEGER;
UPDATE note SET pin_order = (
  SELECT count(*) FROM note n2 WHERE n2.pinned_at IS NOT NULL AND n2.pinned_at <= note.pinned_at
) WHERE pinned_at IS NOT NULL;
`;

// PRAGMA user_version 순번 마이그레이션(D-12 승계). 새 DB도 v0에서 이 배열을 처음부터 끝까지
// 밟아 올라간다 — 경로가 하나다. 한 번 배포된 함수는 절대 고치지 않는다.
export const MIGRATIONS = [(db) => db.exec(V1_SQL), (db) => db.exec(V2_SQL)];
const MIGRATION_SQL = [V1_SQL, V2_SQL];

// 스키마가 실제로 만드는 표 이름 — 가드 테스트가 이것과 대조한다. 가상 표(note_fts)는 색인이라 제외.
export function schemaTables() {
  const names = new Set();
  for (const sql of MIGRATION_SQL) {
    for (const m of sql.matchAll(/CREATE TABLE (\w+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── 이행 전 백업 (D-16 승계)
const BACKUP_KEEP = 5;

function todayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function pruneOldBackups(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^store-v\d+-\d{8}\.sqlite$/.test(f));
    if (files.length <= BACKUP_KEEP) return;
    const withTimes = files
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { f } of withTimes.slice(0, withTimes.length - BACKUP_KEEP)) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    // 정리 실패는 무시 — 이행을 막을 이유가 아니다
  }
}

function backupBeforeMigrate(db, file, fromVersion) {
  try {
    // -wal에 아직 체크포인트되지 않은 메모가 남아 있을 수 있다 — 복사 전에 합친다.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `store-v${fromVersion}-${todayStamp()}.sqlite`));
    pruneOldBackups(dir);
  } catch {
    // 백업 실패가 이행을 막지 않는다
  }
}

function migrate(db, file) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current > MIGRATIONS.length) throw new NewerSchemaError(current, MIGRATIONS.length);
  if (current === MIGRATIONS.length) return;
  if (current > 0) backupBeforeMigrate(db, file, current);
  for (let v = current; v < MIGRATIONS.length; v++) {
    withTransaction(db, () => {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

// ── 손상 판정·격리 (D-15 승계)
class IntegrityCheckFailedError extends Error {}

function checkIntegrity(db) {
  const row = db.prepare('PRAGMA integrity_check').get();
  if (row?.integrity_check !== 'ok') throw new IntegrityCheckFailedError(`integrity_check: ${row?.integrity_check}`);
}

// errcode 26(SQLITE_NOTADB)·11(SQLITE_CORRUPT) 또는 integrity_check 불합격만 손상이다.
// 잠김(5)·권한 오류는 손상이 아니다 — 건강한 파일을 옆으로 미는 일이 절대 없어야 한다.
function isCorruptError(err) {
  if (err instanceof IntegrityCheckFailedError) return true;
  return !!err && (err.errcode === 26 || err.errcode === 11);
}

function quarantine(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '');
  const name = `store.corrupt-${stamp}.sqlite`;
  const dir = path.dirname(file);
  for (const suffix of ['', '-wal', '-shm']) {
    const src = file + suffix;
    if (!fs.existsSync(src)) continue;
    try {
      fs.renameSync(src, path.join(dir, name + suffix));
    } catch {
      // 옆 파일 이동 실패는 본 파일 격리를 막지 않는다
    }
  }
  return name;
}

const now = () => new Date().toISOString();

export function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = null;
  let state = { ok: false, reason: null, notice: null, quarantined: null };

  function closeQuietly() {
    if (!db) return;
    try {
      db.close();
    } catch {
      // 망가진 핸들은 닫기도 실패할 수 있다
    }
    db = null;
  }

  const OPEN_FAIL = '저장소를 열지 못했습니다 — 메모는 로컬 큐에 안전하게 쌓입니다';

  function genericFailure() {
    closeQuietly();
    return { ok: false, reason: 'error', notice: OPEN_FAIL, quarantined: null };
  }

  function pragmas() {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
  }

  function open() {
    try {
      db = new DatabaseSync(file);
      checkIntegrity(db);
    } catch (err) {
      closeQuietly();
      if (!isCorruptError(err)) {
        state = genericFailure();
        return state;
      }
      const quarantinedName = quarantine(file);
      try {
        db = new DatabaseSync(file);
        pragmas();
        migrate(db, file);
        state = { ok: true, reason: 'corrupt', notice: '이전 데이터 파일이 손상되어 보관해 두었습니다', quarantined: quarantinedName };
      } catch {
        closeQuietly();
        state = { ok: false, reason: 'error', notice: OPEN_FAIL, quarantined: quarantinedName };
      }
      return state;
    }
    try {
      pragmas();
      migrate(db, file);
      state = { ok: true, reason: null, notice: null, quarantined: null };
    } catch (err) {
      closeQuietly();
      state =
        err instanceof NewerSchemaError
          ? { ok: false, reason: 'newer', notice: '새 버전으로 만든 데이터입니다 — 앱을 업데이트해 주세요', quarantined: null }
          : genericFailure();
    }
    return state;
  }

  function checkpoint() {
    if (!db) return;
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 체크포인트 실패가 종료를 막지 않는다
    }
  }

  function close() {
    if (!db) return;
    checkpoint();
    try {
      db.close();
    } catch {
      // 이미 닫힌 핸들이어도 넘어간다
    }
    db = null;
  }

  function reopen() {
    close();
    return open();
  }

  function status() {
    return { ...state };
  }

  function mustBeOpen() {
    // 호출부(queue.replayPending·ipc.saveCapture)는 "던지면 실패, 안 던지면 성공"을 전제한다.
    // 조용히 0을 돌려주면 반영되지 않은 큐 항목이 성공으로 오인되어 대기 파일이 지워진다.
    if (!db || !state.ok) throw new Error('store not open');
  }

  // ── 파생 색인 동기화 — 저장할 때마다 본문을 다시 읽어 태그·링크 표를 갈아끼운다(D-02)
  function syncDerived(id, body, title) {
    db.prepare('DELETE FROM note_tag WHERE note_id = ?').run(id);
    const it = db.prepare('INSERT OR IGNORE INTO note_tag (note_id, tag) VALUES (?, ?)');
    for (const tag of extractTags(body)) it.run(id, tag);

    db.prepare('DELETE FROM note_link WHERE from_id = ?').run(id);
    const il = db.prepare('INSERT OR IGNORE INTO note_link (from_id, to_id, to_title) VALUES (?, ?, ?)');
    const find = db.prepare(
      `SELECT id FROM note WHERE title = ? COLLATE NOCASE AND deleted_at IS NULL AND id != ?
        ORDER BY opened_at DESC LIMIT 1`
    );
    for (const toTitle of extractLinks(body)) il.run(id, find.get(toTitle, id)?.id ?? null, toTitle);

    // 이 제목을 가리키던 미해결 링크가 있으면 이제 이 메모를 가리킨다(LINK-02).
    db.prepare(
      'UPDATE note_link SET to_id = ? WHERE to_id IS NULL AND to_title = ? COLLATE NOCASE AND from_id != ?'
    ).run(id, title, id);
  }

  // 캡처 반영 — id가 멱등 키라 재시도돼도 중복이 없다. entries: [{ id, body, captured_at }]
  function insertCaptures(entries) {
    mustBeOpen();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO note (id, body, title, title_cho, body_cho, created_at, updated_at, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    let skipped = 0;
    withTransaction(db, () => {
      for (const e of entries) {
        // 필수 필드는 SQL 전에 검증한다 — 제약 위반이 트랜잭션을 무효화하지 않아 "전부 결함"인
        // 파일이 { inserted: 0 }으로 성공처럼 보이는 일을 막는다(WHENWORK CR-01 승계).
        const body = typeof e?.body === 'string' ? e.body : null;
        if (!e?.id || !e?.captured_at || body == null || !body.trim()) {
          console.error('insertCaptures: 필수 필드 결함으로 항목을 건너뛴다', e?.id);
          skipped += 1;
          continue;
        }
        const title = titleOf(body, e.captured_at);
        const r = insert.run(e.id, body, title, toChoseong(title), toChoseong(body), e.captured_at, e.captured_at, e.captured_at);
        if (r.changes) {
          inserted += 1;
          syncDerived(e.id, body, title);
        }
      }
    });
    return { inserted, skipped };
  }

  // 메인 창의 자동 저장. 본문이 같으면 아무것도 하지 않는다. 제목이 바뀌어도 이 메모를 가리키는
  // 링크는 to_id로 묶여 있어 깨지지 않는다(LINK-04).
  function updateNote(id, body) {
    mustBeOpen();
    const cur = db.prepare('SELECT body, created_at FROM note WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) return null;
    const text = String(body ?? '');
    if (text === cur.body) return { id, title: titleOf(text, cur.created_at), changed: false };
    const title = titleOf(text, cur.created_at);
    const ts = now();
    withTransaction(db, () => {
      db.prepare('UPDATE note SET body = ?, title = ?, title_cho = ?, body_cho = ?, updated_at = ? WHERE id = ?').run(
        text, title, toChoseong(title), toChoseong(text), ts, id
      );
      syncDerived(id, text, title);
    });
    return { id, title, changed: true, updated_at: ts };
  }

  function touchOpened(id) {
    mustBeOpen();
    db.prepare('UPDATE note SET opened_at = ? WHERE id = ?').run(now(), id);
  }

  const NOTE_COLS = 'id, body, title, created_at, updated_at, opened_at, pinned_at, archived_at, deleted_at';

  function getNote(id) {
    mustBeOpen();
    const n = db.prepare(`SELECT ${NOTE_COLS} FROM note WHERE id = ?`).get(id);
    if (!n) return null;
    const tags = db.prepare('SELECT tag FROM note_tag WHERE note_id = ? ORDER BY tag').all(id).map((r) => r.tag);
    const links = db
      .prepare('SELECT to_id, to_title FROM note_link WHERE from_id = ? ORDER BY to_title')
      .all(id)
      .map((r) => ({ title: r.to_title, to_id: r.to_id }));
    const backlinks = db
      .prepare(
        `SELECT n.id, n.title FROM note_link l JOIN note n ON n.id = l.from_id
          WHERE l.to_id = ? AND n.deleted_at IS NULL ORDER BY n.opened_at DESC`
      )
      .all(id);
    return { ...n, tags, links, backlinks };
  }

  // 검색(SRCH-01~05). 정렬은 늘 고정 → 최근 열어본 순(D-03). 관련도 정렬은 하지 않는다.
  function searchNotes({ q = '', limit = 200, archived = false } = {}) {
    mustBeOpen();
    const query = parseQuery(q);
    const where = ['n.deleted_at IS NULL', archived ? 'n.archived_at IS NOT NULL' : 'n.archived_at IS NULL'];
    const params = [];
    if (query.choseong) {
      for (const t of query.terms) {
        where.push("(n.title_cho LIKE ? ESCAPE '\\' OR n.body_cho LIKE ? ESCAPE '\\')");
        const p = likePattern(t);
        params.push(p, p);
      }
    } else {
      const { fts, like } = splitTerms(query.terms);
      const match = ftsMatch(fts);
      if (match) {
        where.push('n.rid IN (SELECT rowid FROM note_fts WHERE note_fts MATCH ?)');
        params.push(match);
      }
      for (const t of like) {
        where.push("(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')");
        const p = likePattern(t);
        params.push(p, p);
      }
    }
    for (const tag of query.tags) {
      where.push('n.id IN (SELECT note_id FROM note_tag WHERE tag = ? COLLATE NOCASE)');
      params.push(tag);
    }
    params.push(limit);
    const rows = db
      .prepare(
        `SELECT n.id, n.title, n.body, n.updated_at, n.opened_at, n.pinned_at, n.archived_at,
                (SELECT group_concat(tag, ' ') FROM note_tag t WHERE t.note_id = n.id) AS tags
           FROM note n
          WHERE ${where.join(' AND ')}
          ORDER BY (n.pinned_at IS NOT NULL) DESC,
                   CASE WHEN n.pinned_at IS NOT NULL THEN n.pin_order END ASC,
                   n.opened_at DESC
          LIMIT ?`
      )
      .all(...params);
    const items = rows.map((r) => ({
      id: r.id,
      title: r.title,
      snippet: makeSnippet(r.body, query),
      updated_at: r.updated_at,
      opened_at: r.opened_at,
      pinned: r.pinned_at != null,
      archived: r.archived_at != null,
      tags: r.tags ? r.tags.split(' ') : [],
    }));
    return { query, items };
  }

  function listTags() {
    mustBeOpen();
    return db
      .prepare(
        `SELECT t.tag, count(*) AS count FROM note_tag t JOIN note n ON n.id = t.note_id
          WHERE n.deleted_at IS NULL AND n.archived_at IS NULL
          GROUP BY t.tag ORDER BY count DESC, t.tag`
      )
      .all();
  }

  function setFlag(column, id, on) {
    mustBeOpen();
    return db.prepare(`UPDATE note SET ${column} = ? WHERE id = ?`).run(on ? now() : null, id).changes > 0;
  }
  const setArchived = (id, on) => setFlag('archived_at', id, on);

  // 고정하면 고정 그룹의 맨 아래로 간다(pin_order = 최대+1). 해제하면 번호를 버린다.
  function setPinned(id, on) {
    mustBeOpen();
    if (!on) return db.prepare('UPDATE note SET pinned_at = NULL, pin_order = NULL WHERE id = ?').run(id).changes > 0;
    return (
      db
        .prepare(
          `UPDATE note SET pinned_at = ?, pin_order = (SELECT COALESCE(MAX(pin_order), 0) + 1 FROM note WHERE pinned_at IS NOT NULL)
            WHERE id = ? AND pinned_at IS NULL`
        )
        .run(now(), id).changes > 0
    );
  }

  // 고정 그룹 안에서 한 칸 위/아래(dir = -1 | 1)로. 고정이 아니거나 끝이면 false.
  // 순서를 다시 매기고 이웃과 바꾼다 — 같은 번호가 생겨도(옛 데이터) 여기서 정리된다.
  function movePinned(id, dir) {
    mustBeOpen();
    const step = dir < 0 ? -1 : 1;
    return withTransaction(db, () => {
      const pinned = db
        .prepare('SELECT id FROM note WHERE pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pin_order, opened_at DESC')
        .all()
        .map((r) => r.id);
      const idx = pinned.indexOf(id);
      if (idx < 0) return false;
      const to = idx + step;
      if (to < 0 || to >= pinned.length) return false;
      [pinned[idx], pinned[to]] = [pinned[to], pinned[idx]];
      const set = db.prepare('UPDATE note SET pin_order = ? WHERE id = ?');
      pinned.forEach((pid, i) => set.run(i + 1, pid));
      return true;
    });
  }
  const removeNote = (id) => setFlag('deleted_at', id, true);
  const restoreNote = (id) => setFlag('deleted_at', id, false);

  // 되돌릴 수 있는 창(30일)을 지난 삭제분을 실제로 비운다. 그 메모를 가리키던 링크는 다시
  // 미해결(to_id NULL)이 되어 누르면 새 메모를 만드는 링크로 돌아간다. 돌려주는 files는
  // 함께 지워야 할 첨부 파일 이름들 — 파일 삭제는 호출부(jobs.mjs)가 attachments 모듈로 한다(STOR-04).
  function purgeDeleted(days = 30) {
    if (!db || !state.ok) return { count: 0, files: [] };
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    return withTransaction(db, () => {
      const ids = db.prepare('SELECT id FROM note WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff).map((r) => r.id);
      if (!ids.length) return { count: 0, files: [] };
      const files = [];
      const del = (sql) => db.prepare(sql);
      for (const id of ids) {
        for (const r of del('SELECT file FROM attachment WHERE note_id = ?').all(id)) files.push(r.file);
        del('UPDATE note_link SET to_id = NULL WHERE to_id = ?').run(id);
        del('DELETE FROM note_link WHERE from_id = ?').run(id);
        del('DELETE FROM note_tag WHERE note_id = ?').run(id);
        del('DELETE FROM attachment WHERE note_id = ?').run(id);
        del('DELETE FROM note WHERE id = ?').run(id);
      }
      return { count: ids.length, files };
    });
  }

  // ── 첨부 (MAIN-08, STOR-04) — 파일은 attachments 모듈이, 여기는 어느 메모의 것인지만
  function addAttachment(noteId, file) {
    mustBeOpen();
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO attachment (id, note_id, file, created_at) VALUES (?, ?, ?, ?)').run(id, noteId, file, now());
    return id;
  }

  function attachmentFiles({ includeDeleted = true } = {}) {
    mustBeOpen();
    const sql = includeDeleted
      ? 'SELECT file FROM attachment'
      : 'SELECT a.file FROM attachment a JOIN note n ON n.id = a.note_id WHERE n.deleted_at IS NULL';
    return db.prepare(sql).all().map((r) => r.file);
  }

  // ── 내보내기·가져오기 (DATA-01·02)
  //
  // 태그·링크 표는 본문에서 파생되므로 내보내지 않는다 — 가져올 때 다시 계산한다(D-02).
  // 초성 컬럼도 같다. 사람이 읽을 파일에는 원본만 담는다.
  function exportAll() {
    mustBeOpen();
    return {
      app: 'whennote',
      export_version: EXPORT_VERSION,
      schema_version: MIGRATIONS.length,
      exported_at: now(),
      note: db
        .prepare(
          `SELECT id, body, created_at, updated_at, opened_at, pinned_at, pin_order, archived_at, deleted_at
             FROM note ORDER BY created_at`
        )
        .all(),
      attachment: db.prepare('SELECT id, note_id, file, created_at FROM attachment ORDER BY created_at').all(),
      event: db.prepare('SELECT id, at, kind, detail FROM event ORDER BY at').all(),
    };
  }

  // 가져오기 직전 현재 파일을 backups/ 에 복사한다(DATA-02). 이름은 이행 백업과 구분되게 reason을 넣는다.
  function backupNow(reason = 'manual') {
    mustBeOpen();
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const dir = path.join(path.dirname(file), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = now().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
      const dest = path.join(dir, `store-${reason}-${stamp}.sqlite`);
      fs.copyFileSync(file, dest);
      return path.basename(dest);
    } catch {
      return null;
    }
  }

  // 지금 데이터를 파일의 내용으로 **갈아끼운다**. 두 단계: 메모를 전부 넣은 뒤 파생 색인을 다시
  // 계산한다 — 링크는 대상 메모가 이미 있어야 to_id로 해석되기 때문이다.
  function importAll(data) {
    mustBeOpen();
    const bad = validateExport(data, MIGRATIONS.length);
    if (bad) throw new Error(bad);
    const backup = backupNow('import');
    withTransaction(db, () => {
      for (const t of ['note_link', 'note_tag', 'attachment', 'event', 'note']) db.exec(`DELETE FROM ${t}`);
      const ins = db.prepare(
        `INSERT INTO note (id, body, title, title_cho, body_cho, created_at, updated_at, opened_at, pinned_at, pin_order, archived_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const n of data.note) {
        const title = titleOf(n.body, n.created_at);
        ins.run(
          n.id, n.body, title, toChoseong(title), toChoseong(n.body),
          n.created_at, n.updated_at ?? n.created_at, n.opened_at ?? n.updated_at ?? n.created_at,
          n.pinned_at ?? null, n.pin_order ?? null, n.archived_at ?? null, n.deleted_at ?? null
        );
      }
      for (const n of data.note) syncDerived(n.id, n.body, titleOf(n.body, n.created_at));
      const ia = db.prepare('INSERT OR IGNORE INTO attachment (id, note_id, file, created_at) VALUES (?, ?, ?, ?)');
      for (const a of data.attachment ?? []) ia.run(a.id, a.note_id, a.file, a.created_at ?? now());
      const ie = db.prepare('INSERT INTO event (id, at, kind, detail) VALUES (?, ?, ?, ?)');
      for (const e of data.event ?? []) ie.run(e.id ?? null, e.at, e.kind, e.detail ?? null);
    });
    return { backup, note: data.note.length, attachment: (data.attachment ?? []).length };
  }

  // 마크다운 내보내기용 — 지운 것을 뺀 전체 메모와 각 메모의 태그
  function allNotes() {
    mustBeOpen();
    const notes = db.prepare(`SELECT ${NOTE_COLS} FROM note WHERE deleted_at IS NULL ORDER BY created_at`).all();
    const tagRows = db.prepare('SELECT note_id, tag FROM note_tag ORDER BY tag').all();
    const tags = new Map();
    for (const r of tagRows) {
      if (!tags.has(r.note_id)) tags.set(r.note_id, []);
      tags.get(r.note_id).push(r.tag);
    }
    return notes.map((n) => ({ ...n, tags: tags.get(n.id) ?? [] }));
  }

  function count() {
    if (!db || !state.ok) return 0;
    return db.prepare('SELECT count(*) AS c FROM note WHERE deleted_at IS NULL').get().c;
  }

  function logEvent(kind, detail = null) {
    try {
      if (!db || !state.ok) return;
      db.prepare('INSERT INTO event (at, kind, detail) VALUES (?, ?, ?)').run(now(), kind, detail == null ? null : String(detail));
    } catch {
      // 지표 기록 실패가 기능을 막지 않는다
    }
  }

  open();

  return {
    open,
    close,
    reopen,
    checkpoint,
    status,
    insertCaptures,
    updateNote,
    touchOpened,
    getNote,
    searchNotes,
    listTags,
    setPinned,
    movePinned,
    setArchived,
    removeNote,
    restoreNote,
    purgeDeleted,
    addAttachment,
    attachmentFiles,
    exportAll,
    importAll,
    backupNow,
    allNotes,
    count,
    logEvent,
    schemaVersion: () => MIGRATIONS.length,
    file,
  };
}
