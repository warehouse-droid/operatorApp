import { createHash } from 'node:crypto';

/**
 * Share only overlapping reads and their encoded bytes. A completed or failed
 * read is removed immediately so the next request observes fresh data.
 * @param {(options: {includeSnapshots: boolean}) => unknown[] | Promise<unknown[]>} load
 */
export function createSharedJsonRead(load) {
  /** @type {Map<boolean, Promise<{body: Buffer, etag: string}>>} */
  const pending = new Map();
  /** @param {boolean} includeSnapshots */
  return function read(includeSnapshots) {
    const existing = pending.get(includeSnapshots);
    if (existing) { return existing; }
    const response = Promise.resolve()
      .then(() => load({ includeSnapshots }))
      .then(rows => {
        const body = Buffer.from(JSON.stringify(rows));
        const hash = createHash('sha1').update(body).digest('base64').slice(0, 27);
        return { body, etag: `W/"${body.length.toString(16)}-${hash}"` };
      })
      .finally(() => pending.delete(includeSnapshots));
    pending.set(includeSnapshots, response);
    return response;
  };
}
