"""Verify and record the weight-notice checks and exact release source."""
import difflib
import hashlib
import json
from pathlib import Path
import sys

server = Path(__file__).resolve().parents[1]
artifact = server / "test-artifacts/dispatch-weight-notices"
checks = Path(sys.argv[1])
adjacent = Path(sys.argv[2])
hashes = json.loads((checks / "source-hashes.json").read_text())
for name, digest in hashes.items():
    assert hashlib.sha256((server / name).read_bytes()).hexdigest() == digest, name
log = (artifact / "gauntlet.log").read_text()
assert "Weight review mutations killed: 4/4" in log
assert "28 test(s)" in log
static = next(json.loads(line) for line in log.splitlines() if line.startswith('{"static":'))
assert static["static"] == "no new diagnostics"
suites = json.loads((adjacent / "suites.json").read_text())
assert suites["current"]["failures"] == suites["baseline"]["failures"]
coverage = json.loads((checks / "coverage/coverage-final.json").read_text())
changed = []
patch = ""
for name in ["src/dispatch-executed-order-review.js", "src/dispatch-executed-order-review-repository.js"]:
    old = (artifact / "baseline" / Path(name).name).read_text()
    current = (server / name).read_text()
    patch += "".join(difflib.unified_diff(old.splitlines(True), current.splitlines(True), fromfile="a/" + name, tofile="b/" + name))
    added = {line + 1 for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old.splitlines(), b=current.splitlines()).get_opcodes()
             if tag in ("insert", "replace") for line in range(start, end)}
    data = coverage["/app/" + name]
    executable = {line for item in data["statementMap"].values() for line in range(item["start"]["line"], item["end"]["line"] + 1)}
    hit = {line for key, item in data["statementMap"].items() if data["s"][key] > 0
           for line in range(item["start"]["line"], item["end"]["line"] + 1)}
    relevant = added & executable
    assert relevant <= hit, (name, sorted(relevant - hit))
    changed.append({"file": name, "covered": len(relevant & hit), "total": len(relevant)})
(server / "test/dispatch-weight-notices.changes.patch").write_text(patch)
result = {"passed": True, "focusedTests": 28, "suites": suites, "mutationsKilled": 4,
          "static": static, "changedLineCoverage": changed, "sourceHashes": hashes,
          "checks": str(checks), "adjacent": str(adjacent)}
(artifact / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
