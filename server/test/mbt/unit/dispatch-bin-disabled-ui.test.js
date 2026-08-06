import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);

test("P3 compatibility: closed BIN gates preserve the established Dispatch order pool and make no BIN feed request", () => {
  assert.match(dispatchSource, /let\s+mbtBinDispatchEnabled\s*=\s*false\s*;/u);
  assert.match(
    dispatchSource,
    /async\s+function\s+loadMbtBinDispatchCapability\([^)]*\)[\s\S]{0,1200}\/api\/mbt\/status[\s\S]{0,1200}capabilities\?\.binDispatch\?\.enabled\s*===\s*true/u
  );
  assert.match(
    dispatchSource,
    /async\s+function\s+loadMbtBinFrontLegs\([^)]*\)\s*\{[\s\S]{0,500}if\s*\(\s*!mbtBinDispatchEnabled\s*\)[\s\S]{0,500}return\s+false\s*;[\s\S]{0,800}fetch\(`/u,
    "The disabled guard must return before the BIN feed fetch."
  );
  assert.match(
    dispatchSource,
    /\[\s*"SO"\s*,\s*"PO"\s*,\s*"TO"\s*,\s*"CO"\s*\]\.map\(\(type\)\s*=>/u,
    "The ordinary order-pool tabs must retain their established shape."
  );
  assert.match(
    dispatchSource,
    /mbtBinDispatchEnabled\s*\?\s*`<button[\s\S]{0,500}data-type="BIN"[\s\S]{0,500}:\s*""/u,
    "The BIN tab must exist only when the capability is confirmed enabled."
  );
  assert.match(
    dispatchSource,
    /render\(\{\s*save:\s*false\s*\}\);[\s\S]{0,300}connectEvents\(\);[\s\S]{0,600}loadMbtBinDispatchCapability\(\)[\s\S]{0,800}loadMbtBinFrontLegs/u,
    "Capability discovery and BIN loading must occur after the ordinary board renders."
  );
});
