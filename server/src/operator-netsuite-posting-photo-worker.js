// @ts-check
import { claimPostingPhoto, completePostingPhoto, failPostingPhoto } from "./operator-netsuite-posting-photo-queue.js";
import { uploadPostingPhoto } from "./operator-netsuite-posting-photos.js";
import { operatorPostingTelemetry } from "./operator-netsuite-posting-telemetry.js";

/** @param {{claim: Function, upload: Function, complete: Function, fail: Function}} dependencies */
export function createPostingPhotoWorker({ claim, upload, complete, fail }) {
  let running = false;
  async function tick() {
    if (running) {return;}
    running = true;
    try {
      // A bounded batch keeps background I/O from monopolizing the application.
      for (let index = 0; index < 2; index += 1) {
        const job = await claim();
        if (!job) {break;}
        await operatorPostingTelemetry.context({ commandId: job.commandId || job.batchId, transactionType: job.transactionType, functionKey: job.functionKey, stage: "photo_upload" }, async () => {
          try {
            await operatorPostingTelemetry.time({ operation: "photo.background", attempt: job.attemptCount, photoId: String(job.id) }, async () => {
              const ref = await upload(job);
              if (!await complete(job, ref)) {
                throw Object.assign(new Error("Photo upload lease expired."), { code: "PHOTO_LEASE_LOST" });
              }
            });
          } catch (error) {await fail(job, error);}
        });
      }
    } finally {running = false;}
  }
  return { tick };
}

export const postingPhotoWorker = createPostingPhotoWorker({ claim: claimPostingPhoto, upload: uploadPostingPhoto, complete: completePostingPhoto, fail: failPostingPhoto });
/** @type {ReturnType<typeof setInterval> | undefined} */
let timer;
export function startPostingPhotoWorker() {
  if (timer) {return;}
  const tick = () => void postingPhotoWorker.tick().catch(() => console.error(JSON.stringify({ event: "operator_photo_worker_error", errorCode: "PHOTO_WORKER_FAILED" })));
  timer = setInterval(tick, 5000);
  timer.unref();
  tick();
}
