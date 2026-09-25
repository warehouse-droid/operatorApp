// Loaded after the board is ready. Only compact drafts enter this database;
// the order catalog is never journaled. All database operations are asynchronous.
export function createDispatchDraftJournal({
  name = 'mbbs.dispatch.pending.v1', maxEntries = 8, maxBytes = 24 * 1024 * 1024,
  maxRecordBytes = 8 * 1024 * 1024, maxAgeMs = 7 * 86400000,
  indexedDB = globalThis.indexedDB
} = {}) {
  let connection;
  function open() {
    if (connection) {return connection;}
    connection = new Promise((resolve, reject) => {
      if (!indexedDB) {return reject(new Error('Draft backup storage is unavailable.'));}
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('drafts');
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      request.onerror = () => { connection = null; reject(request.error); };
      request.onblocked = () => { connection = null; reject(new Error('Draft backup storage is busy.')); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        resolve(db);
      };
    });
    return connection;
  }
  async function transaction(mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'metadata'], mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Draft backup could not be stored.'));
      try { run(tx.objectStore('drafts'), tx.objectStore('metadata'), value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    async write(key, value) {
      if (!key || String(key).length > 256) {throw new Error('Invalid draft backup identity.');}
      const serialized = JSON.stringify(value);
      const bytes = new Blob([serialized]).size;
      if (bytes > maxRecordBytes || bytes > maxBytes) {throw new Error('This draft is too large for local backup. Server saving is still available.');}
      const updatedAt = Date.now();
      return transaction('readwrite', (drafts, metadata) => {
        const request = metadata.getAll();
        request.onsuccess = () => {
          const entries = request.result.filter(entry => entry.key !== key).sort((a, b) => a.updatedAt - b.updatedAt);
          let total = entries.reduce((sum, entry) => sum + entry.bytes, bytes);
          while (entries.length && (entries.length >= maxEntries || total > maxBytes || entries[0].updatedAt < updatedAt - maxAgeMs)) {
            const removed = entries.shift();
            total -= removed.bytes;
            drafts.delete(removed.key);
            metadata.delete(removed.key);
          }
          drafts.put(serialized, key);
          metadata.put({ key, bytes, updatedAt });
        };
      });
    },
    async read(key) {
      return transaction('readwrite', (drafts, metadata, result) => {
        const meta = metadata.get(key);
        meta.onsuccess = () => {
          if (!meta.result || meta.result.updatedAt < Date.now() - maxAgeMs) {
            drafts.delete(key); metadata.delete(key); result(null); return;
          }
          const request = drafts.get(key);
          request.onsuccess = () => {
            try { result(request.result ? JSON.parse(request.result) : null); }
            catch { drafts.delete(key); metadata.delete(key); result(null); }
          };
        };
      });
    },
    async remove(key) {
      return transaction('readwrite', (drafts, metadata) => { drafts.delete(key); metadata.delete(key); });
    },
    async close() { if (connection) {(await connection).close();} connection = null; }
  };
}
