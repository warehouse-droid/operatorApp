import { query, pool, closeDb } from "/app/src/db.js";
import { createPhotoReadToken } from "/app/src/photo-upload.js";

pool.options.options = "-c default_transaction_read_only=on -c statement_timeout=10000";
try {
  const refs = (await query("SELECT photo_data_urls FROM operator_load_records WHERE order_ref='SOB120487' ORDER BY id DESC LIMIT 1")).rows[0].photo_data_urls;
  const actor = { id: "local-load-replay", role: "admin" };
  const photos = [];
  for (const ref of refs) {
    const ticket = createPhotoReadToken({ actor, key: ref });
    const response = await fetch(ticket.objectUrl, { headers: { Authorization: `Bearer ${ticket.token}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) {throw new Error(`Photo read failed: ${response.status}`);}
    const bytes = Buffer.from(await response.arrayBuffer());
    photos.push({ byteSize: bytes.length, dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` });
  }
  console.log(JSON.stringify({ photos }));
} finally {await closeDb();}
