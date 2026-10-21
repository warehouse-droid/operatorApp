"""Record verified source, changed-line coverage and the task-only patch."""
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

server = Path(__file__).resolve().parents[1]
artifact = server / "test-artifacts/dispatch-weight-save"
checks = Path(sys.argv[1])
hashes = json.loads((checks / "source-hashes.json").read_text())
for name, digest in hashes.items():
    assert hashlib.sha256((server / name).read_bytes()).hexdigest() == digest, name
focused = json.loads((checks / "focused.json").read_text())
suites = json.loads((checks / "suites.json").read_text())
mutations = json.loads((checks / "mutations.json").read_text())
static = json.loads((checks / "static.json").read_text())
assert focused["status"] == 0
assert suites["current"]["failures"] == suites["before"]["failures"]
assert all(row["killed"] for row in mutations)
assert static["noNewDiagnostics"]
coverage = json.loads((checks / "coverage/coverage-final.json").read_text())
patch = ""
changed = []
for name in hashes:
    if not name.startswith("src/"):
        continue
    old = (artifact / "baseline" / Path(name).name).read_text()
    new = (server / name).read_text()
    patch += "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile="a/" + name, tofile="b/" + name))
    added = {line + 1 for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old.splitlines(), b=new.splitlines()).get_opcodes()
             if tag in ("insert", "replace") for line in range(start, end)}
    data = coverage["/app/" + name]
    executable = {line for item in data["statementMap"].values() for line in range(item["start"]["line"], item["end"]["line"] + 1)}
    hit = {line for key, item in data["statementMap"].items() if data["s"][key] > 0
           for line in range(item["start"]["line"], item["end"]["line"] + 1)}
    relevant = added & executable
    assert relevant <= hit, (name, sorted(relevant - hit))
    changed.append({"file": name, "covered": len(relevant & hit), "total": len(relevant)})
assert not re.search(r"AKIA[0-9A-Z]{16}|-----BEGIN.*PRIVATE KEY|(?:password|secret|token)\s*[:=]\s*['\"][A-Za-z0-9+/]{24,}", patch)
(server / "test/dispatch-weight-save.changes.patch").write_text(patch)
result = {"passed": True, "focused": focused, "suites": suites, "mutations": mutations,
          "static": static, "changedLineCoverage": changed, "sourceHashes": hashes, "checks": str(checks)}
(artifact / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: result[key] for key in ["passed", "focused", "suites", "static", "changedLineCoverage"]}, indent=2))
