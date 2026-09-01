import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const captureTool = await readFile(new URL("../../../tools/dispatch-planner-history-replay.mjs", import.meta.url), "utf8");
const offlineToolUrl = new URL("../../../tools/dispatch-planner-history-offline-replay.mjs", import.meta.url);

test("DPO-19 production history access is an explicit repeatable-read, read-only capture", () => {
  assert.match(captureTool, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/u);
  assert.match(captureTool, /SHOW transaction_read_only/u);
  assert.match(captureTool, /DISPATCH_REPLAY_CAPTURE_OUTPUT/u);
  assert.match(captureTool, /created_at AS server_at/u,
    "The bounded replay timeline must use the server-created timestamp.");
  assert.match(captureTool, /serverAt:\s*iso\(row\.server_at\)/u);
  assert.doesNotMatch(captureTool, /source:\s*row\.source/u,
    "Potentially identifying source values must be pseudonymized before capture.");
});

test("DPO-19 authoritative replay is offline and hard-fails outside the disposable test environment", async () => {
  const offlineTool = await readFile(offlineToolUrl, "utf8");
  assert.match(offlineTool, /MBT_TEST_ISOLATED/u);
  assert.doesNotMatch(offlineTool, /(?:\.\.\/src\/db\.js|DATABASE_URL|pool\.connect)/u);
  assert.match(offlineTool, /buildDispatchHistoricalReplayArtifact/u);
});
