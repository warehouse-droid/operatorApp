(function operatorPhotoOutbox(/** @type {Window & {OperatorPhotoOutbox?: any}} */ global) {
  "use strict";
  /** @typedef {{id: string, sha256: string, byteSize: number, mimeType: string}} PhotoManifest */
  /** @typedef {PhotoManifest & {blob: Blob, actorId: string, actionId: string, attempt: number, nextAttemptAt: number, leaseUntil: number, leaseToken?: string, missingSince?: number}} QueuedPhoto */
  /** @typedef {{actorId: () => string | null, request: (path: string, options?: RequestInit) => Promise<any>, status?: (state: {count: number, retrying: boolean}) => void}} Configuration */
  /** @type {Promise<IDBDatabase> | undefined} */
  let database;
  /** @type {Configuration | undefined} */
  let configuration;
  let running = false, resumeQueued = false;
  /** @type {number | undefined} */
  let timer;
  // Photos are stored before their confirmation is sent. When the server answers that the confirmation does
  // not exist (it was rejected, or the operator left before it was sent), the photos belong to nothing. They
  // are kept for a day, because a slow or re-sent confirmation with the same request id still attaches them,
  // and then discarded so the device stops retrying and the "photos waiting" notice clears.
  const MISSING_CONFIRMATION_GRACE_MS = 24 * 60 * 60 * 1000;
  const MISSING_CONFIRMATION_RETRY_MS = 10 * 60 * 1000;

  function open() {
    if (database) return database;
    database = new Promise(/** @param {(value: IDBDatabase) => void} resolve */ (resolve, reject) => {
      if (!global.indexedDB) return reject(new Error("Photo storage is unavailable on this device. Load has not been saved."));
      const request = global.indexedDB.open("mbbs-operator-photo-outbox", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("actions", { keyPath: "id" });
        request.result.createObjectStore("photos", { keyPath: "id" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    }).catch(error => { database = undefined; throw error; });
    return database;
  }

  /** @param {string[]} stores @param {IDBTransactionMode} mode @param {(tx: IDBTransaction, done: (value: any) => void) => void} work @returns {Promise<any>} */
  async function transaction(stores, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode, { durability: "strict" });
      /** @type {any} */ let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Could not keep photos on this device. Free storage and try again."));
      try { work(tx, value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  /** @param {string} store @param {IDBValidKey} [key] */
  function read(store, key) {
    return transaction([store], "readonly", (tx, done) => {
      const request = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
      request.onsuccess = () => done(request.result);
    });
  }

  /** @param {string} dataUrl */
  async function photoBytes(dataUrl) {
    const match = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match || match[2].length > 13981016) throw new Error("Retake this photo in a supported format under 10 MB.");
    const binary = global.atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Photo is empty or too large.");
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    return { blob: new Blob([bytes], { type: match[1] }), sha256, byteSize: bytes.length, mimeType: match[1] };
  }

  /** @param {{actorId: string, requestId: string, photos: string[]}} input */
  async function prepare({ actorId, requestId, photos }) {
    if (!photos.length || photos.every(ref => String(ref).startsWith("r2://"))) return { photoDataUrls: photos };
    const images = await Promise.all(photos.map(photoBytes));
    if (images.length > 20 || images.reduce((sum, image) => sum + image.byteSize, 0) > 16 * 1024 * 1024) throw new Error("Photos are too large. Retake fewer or smaller photos.");
    const fingerprint = JSON.stringify(images.map(image => [image.sha256, image.byteSize, image.mimeType]));
    const existing = await read("actions", requestId);
    if (existing) {
      if (existing.actorId !== actorId || existing.fingerprint !== fingerprint) throw new Error("This confirmation has different photos. Reopen the order before confirming again.");
      return { backgroundPhotos: existing.manifest };
    }
    const manifest = images.map(({ sha256, byteSize, mimeType }) => ({ id: global.crypto.randomUUID(), sha256, byteSize, mimeType }));
    // Resolve only after the transaction commits, never merely after put succeeds.
    await transaction(["actions", "photos"], "readwrite", tx => {
      tx.objectStore("actions").add({ id: requestId, actorId, fingerprint, manifest, accepted: false });
      images.forEach((image, index) => tx.objectStore("photos").add({ ...manifest[index], blob: image.blob,
        actorId, actionId: requestId, attempt: 0, nextAttemptAt: 0, leaseUntil: 0 }));
    });
    // Persistent storage is a best-effort request; its absence never discards work.
    void global.navigator.storage?.persist?.().catch(() => {});
    void updateStatus().catch(() => {});
    return { backgroundPhotos: manifest };
  }

  /** @param {string} actorId @returns {Promise<QueuedPhoto | null>} */
  async function claim(actorId) {
    return transaction(["photos"], "readwrite", (tx, done) => {
      const store = tx.objectStore("photos");
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return done(null);
        const photo = row.value;
        if (photo.actorId !== actorId || photo.nextAttemptAt > Date.now() || photo.leaseUntil > Date.now()) return row.continue();
        photo.leaseToken = global.crypto.randomUUID(); photo.leaseUntil = Date.now() + 150000;
        row.update(photo); done(photo);
      };
    });
  }

  /** @param {IDBTransaction} tx @param {QueuedPhoto} photo */
  function discard(tx, photo) {
    const photos = tx.objectStore("photos");
    photos.delete(photo.id);
    let remaining = false;
    const cursor = photos.openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) {
        if (!remaining) tx.objectStore("actions").delete(photo.actionId);
        return;
      }
      if (row.value.actionId === photo.actionId && row.value.id !== photo.id) remaining = true;
      row.continue();
    };
  }

  /** @param {QueuedPhoto} photo @param {boolean} succeeded @param {boolean} [missing] */
  async function finish(photo, succeeded, missing = false) {
    await transaction(["photos", "actions"], "readwrite", tx => {
      const store = tx.objectStore("photos"), request = store.get(photo.id);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || current.leaseToken !== photo.leaseToken) return;
        if (succeeded) { store.delete(photo.id); return; }
        const now = Date.now();
        if (missing) {
          if (!current.missingSince) current.missingSince = now;
          if (now - current.missingSince >= MISSING_CONFIRMATION_GRACE_MS) { discard(tx, current); return; }
        }
        current.attempt += 1; current.leaseUntil = 0;
        current.nextAttemptAt = now + (missing ? MISSING_CONFIRMATION_RETRY_MS : Math.min(60000, 2000 * 2 ** Math.min(current.attempt, 5)));
        store.put(current);
      };
    });
  }

  /** @param {QueuedPhoto} photo */
  async function transfer(photo) {
    if (!configuration) throw new Error("Operator photo queue is not ready.");
    const action = await read("actions", photo.actionId);
    if (!action) throw Object.assign(new Error("Photo confirmation is missing on this device."), { missingConfirmation: true });
    if (!action.accepted) {
      let accepted;
      try { accepted = await configuration.request(`/api/operator/photo-actions/${photo.actionId}`); }
      catch (error) {
        // 404: the server has no confirmation with this id for this operator (never saved).
        if (/** @type {any} */ (error)?.status === 404) throw Object.assign(new Error("Photo confirmation was never saved."), { missingConfirmation: true });
        throw error;
      }
      const acceptedPhotos = /** @type {PhotoManifest[]} */ (accepted.photos);
      if (!acceptedPhotos.some(row => row.id === photo.id && row.sha256 === photo.sha256)) throw new Error("Photo identity changed.");
      action.accepted = true;
      await transaction(["actions"], "readwrite", tx => tx.objectStore("actions").put(action));
    }
    if (configuration.actorId() !== photo.actorId) throw new Error("Operator changed.");
    const result = await configuration.request(`/api/operator/background-photos/${photo.id}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: photo.blob,
      signal: AbortSignal.timeout(120000), priority: "low"
    });
    if (result.id !== photo.id || result.sha256 !== photo.sha256 || result.stored !== true) throw new Error("Photo storage was not acknowledged.");
  }

  async function drain() {
    if (running) { resumeQueued = true; return; }
    if (!configuration?.actorId() || global.navigator.onLine === false) return;
    running = true;
    try {
      const actorId = configuration.actorId();
      if (!actorId) return;
      // Claims are atomic in IndexedDB, including across multiple open tabs.
      for (let index = 0; index < 20 && configuration.actorId() === actorId; index += 1) {
        const photo = await claim(actorId);
        if (!photo) break;
        let succeeded = false, missing = false;
        try { await transfer(photo); succeeded = true; }
        catch (error) { missing = /** @type {any} */ (error)?.missingConfirmation === true; /* Otherwise keep bytes for a later attempt. */ }
        await finish(photo, succeeded, missing);
        await updateStatus();
      }
    } finally {
      running = false;
      if (resumeQueued) { resumeQueued = false; resume(); }
    }
  }

  async function updateStatus() {
    if (!configuration) return;
    const stored = /** @type {QueuedPhoto[]} */ (await read("photos"));
    const actorId = configuration.actorId();
    const photos = stored.filter(photo => photo.actorId === actorId);
    configuration.status?.({ count: photos.length, retrying: photos.some(photo => photo.attempt > 0) });
  }
  function resume() { void drain().catch(() => {}); void updateStatus().catch(() => {}); }
  /** @param {Configuration} options */
  function configure(options) {
    configuration = options;
    if (!timer) timer = global.setInterval(resume, 15000);
    resume();
  }
  global.addEventListener("online", resume);
  global.addEventListener("focus", resume);
  global.OperatorPhotoOutbox = { prepare, configure, resume };
})(window);
