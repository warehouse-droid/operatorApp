import { closeDb, withTransaction } from "./db.js";
import { initializeNetSuiteMirrorCursor } from "./netsuite-mirror-repository.js";

const sequence = Number(process.argv[2]);
if (!Number.isSafeInteger(sequence) || sequence < 0) {
  console.error("Usage: npm run mirror:init -- <source-high-water-sequence>");
  process.exitCode = 1;
} else {
  try {
    const cursor = await withTransaction(() => initializeNetSuiteMirrorCursor(sequence, { scrub: true }));
    console.log(JSON.stringify({
      initialized: true,
      sourceSequence: cursor.sequence,
      scrubbed: ["netsuite_tokens", "operator_sessions", "netsuite_mirror_inbox", "netsuite_mirror_events"]
    }, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

await closeDb();
