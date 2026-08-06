const CHECKOUT_SHA = "11d5960a326750d5838078e36cf38b85af677262";
const UPLOAD_ARTIFACT_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

function blockKeys(source, name, indentation) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`^${escapedName}:\\n((?:[ \\t]+.*(?:\\n|$))*)`, "m")
    .exec(source)?.[1] || "";
  const keyPattern = new RegExp(`^ {${indentation}}([A-Za-z_][A-Za-z0-9_-]*):`, "gm");
  return [...block.matchAll(keyPattern)].map((match) => match[1]);
}

function matchingValues(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function eventBranches(source, eventName) {
  const escapedName = eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const branchBlock = new RegExp(
    `^  ${escapedName}:\\n    branches:\\n((?:      - [^\\n]+\\n?)*)`,
    "m"
  ).exec(source)?.[1] || "";
  return matchingValues(branchBlock, /^      -\s+(\S+)\s*$/gm);
}

function sameValues(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function hasRequiredContract(source, phase) {
  const required = [
    new RegExp(`^name:\\s*MBT Phase ${phase.slice(1)} Gauntlet\\s*$`, "m"),
    /^permissions:\s*\n  contents:\s*read\s*$/m,
    /^    runs-on:\s*ubuntu-24\.04\s*$/m,
    /^    timeout-minutes:\s*90\s*$/m,
    /^      MBT_GAUNTLET_BASE_SHA:\s*\$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}\s*$/m,
    /^          fetch-depth:\s*0\s*$/m,
    /^          persist-credentials:\s*false\s+# secret-scan: allow non-secret GitHub setting\s*$/m
  ];
  return required.every((pattern) => pattern.test(source));
}

function hasForbiddenCapability(source) {
  const forbidden = [
    /pull_request_target\s*:/,
    /workflow_run\s*:/,
    /\bself-hosted\b/,
    /^\s+services\s*:/m,
    /\$\{\{\s*secrets\./,
    /\b(?:permissions|contents|actions|checks|deployments|id-token|issues|packages|pages|pull-requests|security-events|statuses):\s*write\b/i,
    /\bwrite-all\b/i,
    /docker-compose(?:\.v2)?\.yml/i,
    /docker\/env|(?:^|\s)\.env(?:\s|$)/i,
    /mbbs-operator-app/i,
    /MBT_GAUNTLET_SKIP_REGISTRY_AUDIT/i,
    /continue-on-error:\s*true/i,
    /github\.sha/
  ];
  return forbidden.some((pattern) => pattern.test(source));
}

function hasPhaseArtifactContract(source, phase) {
  if (phase !== "P3") {
    return !/upload-artifact/i.test(source);
  }
  const artifactStep = [
    `      - uses: actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`,
    "        if: ${{ always() }}",
    "        with:",
    "          name: mbt-phase-3-gauntlet",
    "          path: server/test-artifacts/",
    "          if-no-files-found: error",
    "          retention-days: 14"
  ].join("\n");
  return source.includes(artifactStep)
    && (source.match(/actions\/upload-artifact@/g) || []).length === 1;
}

function hasSafeTriggers(source, phase, events) {
  if (phase === "P3") {
    return sameValues(events, ["workflow_dispatch", "pull_request", "push"])
      && /^on:\n  workflow_dispatch:\s*\n  pull_request:/m.test(source)
      && sameValues(eventBranches(source, "pull_request"), ["main", "dockerVer"])
      && sameValues(eventBranches(source, "push"), ["main", "dockerVer"]);
  }
  return sameValues(events, ["pull_request", "push"])
    && sameValues(eventBranches(source, "pull_request"), ["main"])
    && sameValues(eventBranches(source, "push"), ["main"]);
}

export function assertMbtCiWorkflow(value, { phase = "P1" } = {}) {
  if (!new Set(["P1", "P2", "P3"]).has(phase)) {
    throw new TypeError("The MBT CI phase must be P1, P2, or P3.");
  }
  const source = String(value || "").replace(/\r\n/g, "\n");
  const events = blockKeys(source, "on", 2);
  const permissions = blockKeys(source, "permissions", 2);
  const jobs = blockKeys(source, "jobs", 2);
  const uses = matchingValues(source, /^\s*-\s+uses:\s*(\S+)\s*$/gm);
  const runs = matchingValues(source, /^\s*-\s+run:\s*(.+?)\s*$/gm);
  const expectedUses = phase === "P3"
    ? [`actions/checkout@${CHECKOUT_SHA}`, `actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`]
    : [`actions/checkout@${CHECKOUT_SHA}`];
  const safe = [
    hasRequiredContract(source, phase),
    hasSafeTriggers(source, phase, events),
    sameValues(permissions, ["contents"]),
    sameValues(jobs, ["gauntlet"]),
    sameValues(uses, expectedUses),
    sameValues(runs, [`bash server/tools/mbt-gauntlet.sh ${phase}`]),
    hasPhaseArtifactContract(source, phase),
    !hasForbiddenCapability(source)
  ].every(Boolean);
  if (!safe) {
    throw new Error(`Unsafe MBT Phase ${phase.slice(1)} CI workflow.`);
  }
  return true;
}
