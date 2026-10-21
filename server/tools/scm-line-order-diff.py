"""Capture this feature's diff against the dirty-workspace starting snapshots."""

import hashlib
import json
from pathlib import Path
import re
import subprocess


FILES = [
    "public/scm-smart-line-order-core.js", "public/scm-smart-line-order.js",
    "src/smart-scm-line-order.js", "src/smart-scm-line-order-repository.js",
    "src/smart-scm-created-po.js", "src/smart-scm-purchase-netsuite.js",
    "src/transfer-dependency-netsuite.js", "src/smart-scm-planning-repository.js",
    "src/smart-scm-vendor-repository.js", "src/server.js", "public/scm-smart.js",
    "public/scm-smart-proposals.js", "public/scm-smart-vendor.js",
    "public/scm-smart-proposals.css", "public/scm-smart.html",
    "migrations/244_smart_scm_line_order.sql",
]

directory = Path("test-artifacts/scm-line-order")
manifest = {}
for name in FILES:
    source = Path(name).read_text()
    baseline = directory / "baseline" / name
    if baseline.exists():
        diff = subprocess.run(
            ["git", "diff", "--no-index", "--diff-algorithm=patience", "--unified=0", "--", str(baseline), name],
            capture_output=True, text=True, check=False,
        )
        if diff.returncode not in (0, 1):
            raise RuntimeError(diff.stderr)
        lines = [
            line
            for start, count in re.findall(r"^@@.*\+(\d+)(?:,(\d+))? @@", diff.stdout, re.MULTILINE)
            for line in range(int(start), int(start) + int(count or 1))
        ]
        additions = "\n".join(line for line in diff.stdout.splitlines() if line.startswith("+") and not line.startswith("+++"))
    else:
        lines = list(range(1, len(source.splitlines()) + 1))
        additions = source
    manifest[name] = {"lines": lines, "additions": additions, "sha256": hashlib.sha256(source.encode()).hexdigest()}
(directory / "final" / "task-diff.json").write_text(json.dumps(manifest, indent=2) + "\n")
