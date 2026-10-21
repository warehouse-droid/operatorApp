#!/usr/bin/env python3
"""Record source identity and changed backend coverage for the final saved run."""
import difflib
import hashlib
import json
import pathlib
import sys

server = pathlib.Path(__file__).resolve().parents[1]
artifact = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else (
    server / "test-artifacts/delivery-timeslot-notifications-20261014"
)
runtime = [
    "src/delivery-request-domain.js", "src/delivery-request-repository.js",
    "public/delivery-requests.js", "public/delivery-requests.html",
    "public/delivery-request-alert.js", "public/app-sidebar.js",
    "public/regular-stock-alert.js", "public/special-delivery-method-alert.js",
    "public/special-po-reference-alert.js", "public/app-notifications.js",
    "public/app-notification-worker.js",
]
coverage = json.loads((artifact / "final/results/coverage/coverage-final.json").read_text())
changed_backend = {}
patch = []
for name in runtime:
    current = (server / name).read_text()
    previous_path = artifact / "before" / name
    previous = previous_path.read_text() if previous_path.exists() else ""
    patch.extend(difflib.unified_diff(
        previous.splitlines(keepends=True), current.splitlines(keepends=True),
        fromfile="before/" + name, tofile="after/" + name,
    ))
    if name.startswith("src/"):
        changed = set()
        for operation, _, _, start, end in difflib.SequenceMatcher(
            a=previous.splitlines(), b=current.splitlines(), autojunk=False,
        ).get_opcodes():
            if operation in ("insert", "replace"):
                changed.update(range(start + 1, end + 1))
        item = coverage["/app/" + name]
        counts = {}
        for key, span in item["statementMap"].items():
            for line in range(span["start"]["line"], span["end"]["line"] + 1):
                counts[line] = max(counts.get(line, 0), item["s"][key])
        eligible = sorted(changed & counts.keys())
        missed = [line for line in eligible if counts[line] <= 0]
        changed_backend[name] = {
            "changedInstrumentedLines": len(eligible),
            "covered": len(eligible) - len(missed), "missed": missed,
        }
(artifact / "changes.patch").write_text("".join(patch))
(artifact / "final/results/changed-backend-line-coverage.json").write_text(
    json.dumps(changed_backend, indent=2) + "\n"
)

# Identify the runtime, migrations, scoped tests and supporting tooling, even in
# a dirty workspace. Do not include local credentials, dependency directories,
# browser profiles, databases, or production data.
paths = set()
for directory in ("src", "public", "migrations", "test/mbt", "test/support"):
    paths.update(p for p in (server / directory).rglob("*") if p.is_file())
paths.update(server / name for name in ("package.json", "package-lock.json") if (server / name).exists())
paths.update(server / name for name in runtime)
paths.update(p for p in (server / "tools").glob("delivery-timeslot-notifications*") if p.is_file())
paths.update(server / "tools" / name for name in (
    "delivery-request-enhancements-test.sh", "delivery-request-enhancements-tooling.sh",
    "delivery-request-eslint.config.mjs", "delivery-request-quality.mjs",
    "tsconfig.delivery-requests.json",
))
hashes = {
    str(path.relative_to(server)): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in sorted(paths)
}
canonical = json.dumps(hashes, sort_keys=True, separators=(",", ":"))
tree_hash = hashlib.sha256(canonical.encode()).hexdigest()
live = json.loads((artifact / "live-source-hashes.json").read_text())
deployment_file = server / "deployments/delivery-timeslot-notifications-20261014/deployment-result.json"
deployment = json.loads(deployment_file.read_text()) if deployment_file.exists() else None
report = {
    "specApproval": "not obtained (autonomous run)",
    "sourceTreeSha256": tree_hash, "sourceHashes": hashes,
    "runtimeHashes": {name: hashes[name] for name in runtime},
    "liveRuntimeMatches": [name for name in runtime if live.get(name) == hashes[name]],
    "testResults": json.loads((artifact / "final/results/test-results.json").read_text()),
    "changedBackendLineCoverage": changed_backend,
    "backendCoverage": json.loads((artifact / "final/results/coverage/coverage-summary.json").read_text())["total"],
    "mutations": json.loads((artifact / "final/results/mutations.json").read_text()),
    "toolVersions": json.loads((artifact / "final/results/versions.log").read_text()),
    "deploymentPerformed": bool(deployment and deployment.get("deployed")),
    "deployment": deployment,
}
(artifact / "EVIDENCE.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({
    "sourceTreeSha256": tree_hash, "sourceFiles": len(hashes),
    "testResults": report["testResults"], "changedBackendLineCoverage": changed_backend,
    "liveRuntimeMatches": report["liveRuntimeMatches"],
}, indent=2))
