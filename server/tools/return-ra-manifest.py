"""Capture task-local changes against the preserved starting workspace."""
import difflib
import hashlib
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
baseline = Path(os.environ.get("RETURN_RA_BASELINE", "/tmp/return-ra-baseline-fixed"))
existing = ["src/return-netsuite.js", "src/return-repository.js", "src/netsuite.js", "src/server.js",
            "src/operator-netsuite-posting-policy.js", "src/mbt/feature-gate-catalog.js",
            "public/operator.js", "public/operator.html", "public/service-worker.js", "public/control.js",
            "public/control.html", "public/sales.js", "public/sales.html", "public/mbt-gates.js",
            "public/mbt-gates.html", "test/mbt/unit/operator-yard-assets.test.js", "public/admin.html"]
existing += ["test/mbt/unit/" + name for name in ["operator-customer-pickup-photo-gate-ui.contract.test.js",
    "operator-page-confirm-ui.contract.test.js", "operations-navigation-enhancements.test.js", "control-yard-photo-thumbnail.test.js"]]
existing += ["test/mbt/unit/feature-gate-catalog.test.js", "test/mbt/integration/feature-gate-admin-http.test.js",
             "test/mbt/integration/http-shell.test.js", "test/mbt/integration/migration-upgrade.test.js"]
existing += ["tools/mbt-predeploy-readiness.mjs", "test/mbt/integration/p3-predeploy-readiness.test.js"]
added = ["src/return-ra-workflow.js", "migrations/203_operator_return_authorizations.sql"]
added += [str(p.relative_to(root)) for area in ["test/mbt", "tools"]
          for p in (root / area).rglob("return-ra-*") if p.is_file()]
manifest, reverse = [], []
for name in existing + sorted(set(added)):
    path = root / name
    after = path.read_text()
    before = (baseline / name).read_text() if name in existing else ""
    changed = []
    for op, _i, _j, k, end in difflib.SequenceMatcher(None, before.splitlines(), after.splitlines()).get_opcodes():
        if op != "equal":
            changed.extend(range(k + 1, end + 1))
    manifest.append({"file": name, "beforeSha256": hashlib.sha256(before.encode()).hexdigest() if before else None,
                     "afterSha256": hashlib.sha256(after.encode()).hexdigest(), "changedLines": changed})
    if before:
        reverse.extend(difflib.unified_diff(after.splitlines(True), before.splitlines(True),
                                          fromfile="a/" + name, tofile="b/" + name))
folder = root / "test-artifacts/return-ra-workflow"
folder.mkdir(parents=True, exist_ok=True)
(folder / "changes.json").write_text(json.dumps(manifest, indent=2) + "\n")
(root / "test/support/return-ra-baseline.patch").write_text("".join(reverse))
print(json.dumps({"files": len(manifest), "changedLines": sum(len(r["changedLines"]) for r in manifest)}))
