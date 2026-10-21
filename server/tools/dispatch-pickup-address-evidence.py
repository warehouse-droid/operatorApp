"""Record reproducible baseline, mutation, static and changed-line coverage evidence."""
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import sys

server = Path(__file__).resolve().parents[1]
artifact = server / "test-artifacts/dispatch-pickup-override"
checks = Path(sys.argv[1])
log = (artifact / "final.log").read_text()
assert "26 test(s)" in log and "Pickup override mutations killed: 5/5" in log
static = next(json.loads(line) for line in log.splitlines() if line.startswith('{"static":'))
assert static["static"] == "no new diagnostics"
suites = json.loads((checks / "suites.json").read_text())
assert suites["current"] == suites["baseline"]
hashes = json.loads((checks / "source-hashes.json").read_text())
for name, value in hashes.items():
    assert hashlib.sha256((server / name).read_bytes()).hexdigest() == value, name
coverage = json.loads((checks / "coverage/coverage-final.json").read_text())
coverage.update(json.loads((checks / "browser-istanbul.json").read_text()))
changed = []
patch = ""
for name in ["public/dispatch.js", "public/dispatch.html", "src/dispatch-pickup-visits.js", "src/scm-dependency-plan-reconciler.js"]:
    old = (artifact / "baseline" / name).read_text()
    current = (server / name).read_text()
    patch += "".join(difflib.unified_diff(old.splitlines(True), current.splitlines(True), fromfile="a/" + name, tofile="b/" + name))
    shutil.copy2(artifact / "baseline" / name, artifact / "baseline" / Path(name).name)
    if name.endswith(".html"):
        assert "/dispatch.js?v=20260928-pickup-override-v1" in current
        continue
    added = {line + 1 for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old.splitlines(), b=current.splitlines()).get_opcodes()
             if tag in ("insert", "replace") for line in range(start, end)}
    data = coverage["/app/" + name]
    executable = {line for item in data["statementMap"].values() for line in range(item["start"]["line"], item["end"]["line"] + 1)}
    hit = {line for key, item in data["statementMap"].items() if data["s"][key] > 0
           for line in range(item["start"]["line"], item["end"]["line"] + 1)}
    relevant = added & executable
    assert relevant and relevant <= hit, (name, sorted(relevant - hit))
    changed.append({"file": name, "covered": len(relevant & hit), "total": len(relevant)})
(server / "test/dispatch-pickup-address.changes.patch").write_text(patch)
result = {"passed": True, "focusedTests": 26, "mutationsKilled": 5, "suites": suites,
          "static": static, "changedLineCoverage": changed, "sourceHashes": hashes, "checks": str(checks)}
(artifact / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
