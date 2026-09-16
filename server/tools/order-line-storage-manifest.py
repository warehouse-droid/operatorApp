"""Record only this task's changes against the preserved working-tree snapshot."""
import difflib
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
artifact = root / "test-artifacts/order-line-storage"
before = json.loads((artifact / "baseline-hashes.json").read_text())
files = set(before)
for folder in ["src", "test", "tools", "migrations"]:
    files.update(str(p.relative_to(root)) for p in (root / folder).rglob("*")
                 if p.is_file() and "__pycache__" not in str(p))
rows, patches = [], []
owned_runtime = {
    "migrations/202_netsuite_order_line.sql", "netsuite-order-webhook-scheduled.js",
    "netsuite-order-webhook-user-event-direct.js", "src/netsuite-mirror-repository.js",
    "src/netsuite-order-line-backfill.js", "src/netsuite-order-line.js", "src/netsuite.js",
    "src/order-sync-repository.js", "src/sales-order-reconciliation.js",
    "src/scm-netsuite-po-history-service.js", "src/scm-reconciliation-service.js", "src/server.js",
    "test/mbt/integration/migration-upgrade.test.js", "test/mbt/integration/p3-predeploy-readiness.test.js",
    "tools/mbt-predeploy-readiness.mjs"
}
def owned(file):
    return file in owned_runtime or file.startswith(("tools/order-line-storage-", "test/order-line-storage-",
        "test/mbt/unit/netsuite-order-line", "test/mbt/integration/netsuite-order-line"))

for file in sorted(files):
    candidate = root / file
    if not candidate.is_file():
        continue
    digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    if before.get(file) == digest:
        continue
    if not owned(file):
        print(f"Preserving concurrent change outside this release: {file}")
        continue
    old = (artifact / "baseline" / file).read_text() if file in before else ""
    new = candidate.read_text()
    changed = []
    for tag, _, _, start, end in difflib.SequenceMatcher(None, old.splitlines(), new.splitlines()).get_opcodes():
        if tag in ["insert", "replace"]:
            changed.extend(range(start + 1, end + 1))
    rows.append({"file": file, "beforeSha256": before.get(file), "afterSha256": digest, "changedLines": changed})
    patches.extend(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile="before/" + file, tofile="after/" + file))
(artifact / "changes.json").write_text(json.dumps(rows, indent=2) + "\n")
(artifact / "changes.patch").write_text("".join(patches))
print(f"Recorded {len(rows)} changed files")
