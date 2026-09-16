// main/jobs.mjs — 백그라운드 작업. 남는 것은 큐 반영 1회와 purge뿐이다(브리핑은 WHENWORK의 것).
// 모두 저장소만 거치고 외부 프로세스를 부르지 않는다.

const PURGE_DAYS = 30; // 소프트 삭제한 메모를 실제로 비우기까지 두는 기간(MAIN-05)
const PURGE_DELAY_MS = 30_000; // 켜자마자 부팅이 무거워지지 않도록 조금 뒤에

export function scheduleJobs(ctx) {
  // 큐 → 저장소, 앱 시작 시 딱 1회(D-01/D-02 승계). 실행 중에는 다시 부르지 않는다 — 주기
  // 타이머로 되살리면 읽기-쓰기 경합이 돌아온다. 반영에 실패한 파일은 replayPending이 남겨 두고
  // 다음 기동이 재시도한다.
  function replayQueueOnce() {
    try {
      ctx.queue.replayPending((entries) => ctx.store.insertCaptures(entries));
      ctx.pending = 0;
    } catch {
      // replayPending 자체는 던지지 않는 계약이지만 안전망으로 남겨둔다
    }
    ctx.refreshTrayMenu();
  }

  // 표에서 지운 뒤 그 메모의 첨부 파일도 지운다(STOR-04). 파일 삭제 실패는 다음 기동이 다시 본다 —
  // 표 행은 이미 없으므로 고아 파일 정리(purgeOrphans)가 집어 간다.
  function purgeOnce() {
    try {
      const { files } = ctx.store.purgeDeleted(PURGE_DAYS);
      ctx.attachments?.remove(files);
    } catch {
      // 실패해도 다음 기동이 다시 시도한다
    }
  }

  // 표에 없는 첨부 파일(가져오기 실패·삭제 실패 등으로 남은 것)을 치운다
  function purgeOrphans() {
    try {
      const known = new Set(ctx.store.attachmentFiles());
      ctx.attachments?.remove(ctx.attachments.list().filter((f) => !known.has(f)));
    } catch {
      // 조용히 — 다음 기동에
    }
  }

  ctx.jobs = { replayQueueOnce, purgeOnce, purgeOrphans };

  // 큐 반영은 !SMOKE 가드 밖이다 — 강제종료 스모크가 두 번째 기동에서 이 반영을 본다.
  replayQueueOnce();
  if (!ctx.SMOKE) {
    setTimeout(() => {
      purgeOnce();
      purgeOrphans();
    }, PURGE_DELAY_MS);
  }
}
