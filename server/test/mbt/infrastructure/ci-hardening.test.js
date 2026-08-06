import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertMbtCiWorkflow } from "../../support/ci-workflow-contract.mjs";

const CHECKOUT_SHA = "11d5960a326750d5838078e36cf38b85af677262";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, "../../..");
const SAFE_WORKFLOW = [
  "name: MBT Phase 1 Gauntlet",
  "",
  "on:",
  "  pull_request:",
  "    branches:",
  "      - main",
  "  push:",
  "    branches:",
  "      - main",
  "",
  "permissions:",
  "  contents: read",
  "",
  "jobs:",
  "  gauntlet:",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 90",
  "    env:",
  "      MBT_GAUNTLET_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}",
  "    steps:",
  `      - uses: actions/checkout@${CHECKOUT_SHA}`,
  "        with:",
  "          fetch-depth: 0",
  "          persist-credentials: false # secret-scan: allow non-secret GitHub setting",
  "      - run: bash server/tools/mbt-gauntlet.sh P1",
  ""
].join("\n");
const SAFE_P2_WORKFLOW = SAFE_WORKFLOW
  .replace("MBT Phase 1 Gauntlet", "MBT Phase 2 Gauntlet")
  .replace("mbt-gauntlet.sh P1", "mbt-gauntlet.sh P2");

test("quality CI: the minimal Phase 1 workflow is accepted", () => {
  assert.equal(assertMbtCiWorkflow(SAFE_WORKFLOW), true);
});

test("P2-F07: the minimal Phase 2 workflow is accepted only under its exact phase contract", () => {
  assert.equal(assertMbtCiWorkflow(SAFE_P2_WORKFLOW, { phase: "P2" }), true);
  assert.throws(
    () => assertMbtCiWorkflow(SAFE_P2_WORKFLOW),
    /unsafe MBT Phase 1 CI workflow/i
  );
  assert.throws(
    () => assertMbtCiWorkflow(SAFE_WORKFLOW, { phase: "P2" }),
    /unsafe MBT Phase 2 CI workflow/i
  );
});

test("quality CI: elevated or production-capable workflow variants fail closed", () => {
  const unsafeVariants = [
    SAFE_WORKFLOW.replace("pull_request:", "pull_request_target:"),
    SAFE_WORKFLOW.replace("      - main\n\npermissions:", "      - main\n  workflow_dispatch:\n\npermissions:"),
    SAFE_WORKFLOW.replace("contents: read", "contents: write"),
    SAFE_WORKFLOW.replace("ubuntu-24.04", "self-hosted"),
    SAFE_WORKFLOW.replace("timeout-minutes: 90", "timeout-minutes: 120"),
    SAFE_WORKFLOW.replace(`actions/checkout@${CHECKOUT_SHA}`, "actions/checkout@v4"),
    SAFE_WORKFLOW.replace("fetch-depth: 0", "fetch-depth: 1"),
    SAFE_WORKFLOW.replace("persist-credentials: false", "persist-credentials: true"),
    SAFE_WORKFLOW.replace(
      "github.event.pull_request.base.sha || github.event.before",
      "github.sha"
    ),
    SAFE_WORKFLOW.replace(
      "      - run: bash server/tools/mbt-gauntlet.sh P1",
      "      - run: docker compose -f docker-compose.yml up"
    ),
    `${SAFE_WORKFLOW}\n    services:\n      postgres:\n        image: postgres:latest`,
    SAFE_WORKFLOW + "\n    env:\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    `${SAFE_WORKFLOW}\n      - uses: actions/upload-artifact@v4`,
    `${SAFE_WORKFLOW}\n      - run: MBT_GAUNTLET_SKIP_REGISTRY_AUDIT=1 bash server/tools/mbt-gauntlet.sh P1`
  ];

  for (const source of unsafeVariants) {
    assert.throws(() => assertMbtCiWorkflow(source), /unsafe MBT Phase 1 CI workflow/i);
  }
});

test("quality CI: the gauntlet executes the collector contract and validates the real workflow", async () => {
  const gauntlet = await readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8");
  const collectorHarness = await readFile(
    path.join(serverRoot, "test/support/gauntlet-change-collector-harness.sh"),
    "utf8"
  );
  assert.match(gauntlet, /gauntlet-change-collector-harness\.sh/);
  assert.match(gauntlet, /mbt-collect-changes\.sh/);
  assert.match(gauntlet, /verify-ci-workflow\.mjs/);
  assert.match(gauntlet, /mbt-p2\.yml/);
  assert.match(gauntlet, /mapfile\s+-d\s+''\s+-t/);
  assert.match(collectorHarness, /unset\s+MBT_GAUNTLET_BASE_SHA/);
});
