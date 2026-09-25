import { createPostingPhotoWorker } from "./operator-netsuite-posting-photo-worker.js";
import { uploadPostingPhoto } from "./operator-netsuite-posting-photos.js";
import { claimBackgroundPhoto, completeBackgroundPhoto, failBackgroundPhoto } from "./operator-background-photos.js";

export const backgroundPhotoWorker = createPostingPhotoWorker({ claim: claimBackgroundPhoto,
  upload: uploadPostingPhoto, complete: completeBackgroundPhoto, fail: failBackgroundPhoto });
/** @type {ReturnType<typeof setInterval> | undefined} */
let timer;
export function startBackgroundPhotoWorker() {
  if (timer) return;
  const tick = () => void backgroundPhotoWorker.tick().catch(() => console.error("Operator background photo worker failed; queued photos retained."));
  timer = setInterval(tick, 5000);
  timer.unref();
  tick();
}
