"""Use final-run V8 ranges, including real browser execution, for changed lines."""
import difflib
import hashlib
import json
from pathlib import Path

TASK = Path(__file__).resolve().parent
OUT = TASK.parents[1] / "test-artifacts/dispatch-grouping-reliability-20261020"
FILES = ["public/dispatch.js", "src/dispatch-delivery-group-repository.js",
         "src/dispatch-planner-v2-repository.js", "src/server.js"]
scripts = {name: [] for name in FILES}
for path in (OUT / "coverage-final").glob("*.json"):
    for script in json.loads(path.read_text()).get("result", []):
        for name in FILES:
            if script["url"].endswith("/" + name) or script["url"] == name:
                scripts[name].append(script)
for path in (OUT / "edit-group-browser").glob("*.json"):
    for script in json.loads(path.read_text()):
        if script["url"].split("?")[0].endswith("/dispatch.js") and script.get("source") == (TASK / "candidate/public/dispatch.js").read_text():
            scripts["public/dispatch.js"].append(script)

result = {"files": {}, "missing": []}
for name in FILES:
    before = (TASK / "baseline" / name).read_text().splitlines(True)
    source = (TASK / "candidate" / name).read_text()
    after = source.splitlines(True)
    changed = []
    for tag, _a, _b, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
        if tag in ["insert", "replace"]:
            changed += [i for i in range(start, end) if after[i].strip() and not after[i].lstrip().startswith(("//", "/*", "*"))]
    offsets, offset = [], 0
    for line in after:
        offsets.append(offset)
        offset += len(line.encode("utf-16-le")) // 2
    covered, missing = [], []
    for line in changed:
        position = offsets[line] + len(after[line]) - len(after[line].lstrip())
        executed = False
        for script in scripts[name]:
            ranges = [r for fn in script["functions"] for r in fn["ranges"] if r["startOffset"] <= position < r["endOffset"]]
            if ranges and min(ranges, key=lambda r: r["endOffset"] - r["startOffset"])["count"] > 0:
                executed = True
                break
        (covered if executed else missing).append(line + 1)
    result["files"][name] = {"covered": len(covered), "total": len(changed), "missing": missing,
                              "sha256": hashlib.sha256(source.encode()).hexdigest()}
    result["missing"] += [{"file": name, "line": line} for line in missing]
(OUT / "changed-coverage.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
