"""Freeze the tested source hashes and changed-line inventory."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[2]
server = root / "server"
artifact = server / "test-artifacts/operator-direct-orderline"
artifact.mkdir(parents=True, exist_ok=True)
base = "8640191"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=root)


names = set(git("diff", "--name-only", base).decode().splitlines())
names.update(git("ls-files", "--others", "--exclude-standard").decode().splitlines())
manifest = []
for name in sorted(names):
    if not name.startswith("server/"):
        continue
    file = name.removeprefix("server/")
    if file.startswith("test-artifacts/") or not (server / file).is_file():
        continue
    content = (server / file).read_bytes()
    result = subprocess.run(["git", "show", f"{base}:{name}"], cwd=root, capture_output=True)
    before = result.stdout if result.returncode == 0 else None
    if before is None:
        lines = list(range(1, len(content.splitlines()) + 1))
    else:
        diff = git("diff", "--unified=0", base, "--", name).decode()
        lines = []
        for start, count in re.findall(r"^@@ .*? \+(\d+)(?:,(\d+))? @@", diff, re.M):
            lines.extend(range(int(start), int(start) + int(count or 1)))
    manifest.append({"file": file, "beforeSha256": hashlib.sha256(before).hexdigest() if before is not None else None,
                     "afterSha256": hashlib.sha256(content).hexdigest(), "changedLines": lines})
(artifact / "changes.json").write_text(json.dumps(manifest, indent=2) + "\n")
(artifact / "source-state.json").write_text(json.dumps({"base": git("rev-parse", base).decode().strip(),
    "sourceHash": hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()}, indent=2) + "\n")
focus = sorted({str(path.relative_to(server)) for pattern in [
    "test/mbt/unit/operator-netsuite-*.test.js", "test/mbt/unit/operator-direct-orderline-client.test.js",
    "test/mbt/unit/operator-posting*.test.js", "test/mbt/unit/operator-yard-assets.test.js",
    "test/mbt/unit/operator-customer-pickup-photo-gate-ui.contract.test.js", "test/mbt/unit/operations-navigation-enhancements.test.js",
    "test/mbt/unit/operator-page-confirm-ui.contract.test.js", "test/mbt/integration/consolidation-load.test.js",
    "test/mbt/integration/operator-netsuite-*.test.js", "test/mbt/integration/operator-receiving-allocations.test.js",
    "test/mbt/integration/sn1400625*.test.js", "test/mbt/unit/sn1400333-receiving.test.js",
    "test/mbt/unit/operator-photo*.test.js", "test/mbt/integration/operator-photo*.test.js"
] for path in server.glob(pattern)})
(artifact / "focus.json").write_text(json.dumps(focus, indent=2) + "\n")
print(json.dumps({"files": len(manifest), "focusFiles": len(focus)}))
