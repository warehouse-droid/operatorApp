"""Capture this task's runtime delta against its preserved working-tree baseline."""
import difflib
import hashlib
import json
from pathlib import Path

server = Path(__file__).resolve().parents[1]
artifact = server / "test-artifacts/bin-order-workflow-20261020"
baseline = json.loads((artifact / "baseline-hashes.json").read_text())
files = {
    name for name, digest in baseline.items()
    if (server / name).is_file()
    and hashlib.sha256((server / name).read_bytes()).hexdigest() != digest
}
for pattern in ("src/mbt/bin-order-workflow-*.js", "public/bin-order-workflow*",
                "migrations/297_bin_order_workflows.sql"):
    files.update(str(path.relative_to(server)) for path in server.glob(pattern))
files = sorted(files)
(server / "tools/bin-order-workflow-files.json").write_text(json.dumps(files, indent=2) + "\n")
changed = {}
patch = []
hashes = {}
for name in files:
    current = (server / name).read_text()
    path = artifact / "baseline" / name
    original = path.read_text() if path.exists() else ""
    before, after = original.splitlines(keepends=True), current.splitlines(keepends=True)
    lines = []
    for tag, _a, _b, start, end in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        if tag in ("replace", "insert"):
            lines.extend(range(start + 1, end + 1))
    changed[name] = lines
    hashes[name] = hashlib.sha256((server / name).read_bytes()).hexdigest()
    patch.extend(difflib.unified_diff(before, after, fromfile="a/server/" + name, tofile="b/server/" + name, n=3))
output = artifact / "browser-artifacts"
(output / "workflow-changed-lines.json").write_text(json.dumps(changed, indent=2) + "\n")
(output / "workflow-runtime.diff").write_text("".join(patch))
state = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
(output / "workflow-source-state.json").write_text(json.dumps({"treeHash": state, "files": hashes}, indent=2) + "\n")
print(json.dumps({"files": len(files), "treeHash": state}))
