"""Compare executable coverage with the captured pre-change Maps sources."""
import difflib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / "test-artifacts/maps-daily-capacity"
coverage = json.loads((out / "coverage/coverage-final.json").read_text())
results = {}
for name in ["src/google-maps-usage-policy.js", "src/google-maps-usage-repository.js"]:
    before = (out / "baseline" / name).read_text().splitlines()
    after = (root / name).read_text().splitlines()
    changed = set()
    for operation, _, _, start, end in difflib.SequenceMatcher(None, before, after).get_opcodes():
        if operation in ["insert", "replace"]:
            changed.update(range(start + 1, end + 1))
    file_coverage = next(value for key, value in coverage.items() if key.endswith("/" + name))
    lines = {}
    for key, span in file_coverage["statementMap"].items():
        for line in range(span["start"]["line"], span["end"]["line"] + 1):
            lines[line] = max(lines.get(line, 0), file_coverage["s"][key])
    missing = sorted(line for line in changed if lines.get(line, 0) == 0)
    results[name] = {"changedLines": len(changed), "covered": len(changed) - len(missing), "uncovered": missing}
    assert not missing, name + ": uncovered changes " + str(missing)
(out / "changed-line-coverage.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps(results))
