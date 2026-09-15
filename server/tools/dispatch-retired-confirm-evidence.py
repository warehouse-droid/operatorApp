"""Compare existing diagnostics without hiding new failures."""
import json
import re
import sys
from pathlib import Path


def failures(file):
    data = Path(file).read_text()
    failed = set(re.findall(r"^not ok \d+ - (.+)$", data, re.M))
    failed.update(re.findall(r"^[✖✗] (.+?)(?: \([\d.]+m?s\))?$", data, re.M))
    failed.update(re.findall(r"^Error: (.+)$", data, re.M))
    return failed


if sys.argv[1] == "compare":
    before, after = (failures(file) for file in sys.argv[2:4])
    assert after, "Nonzero suite exit without a recognized failure; inspect the log"
    assert not after - before, f"New failures: {sorted(after - before)}"
    print(json.dumps({"existing_failures": sorted(after), "new_failures": 0}))
elif sys.argv[1] == "types":
    def diagnostics(file):
        return sorted(re.sub(r"\(\d+,\d+\)", "(line,column)", line) for line in Path(file).read_text().splitlines() if "error TS" in line)
    before, after = (diagnostics(file) for file in sys.argv[2:4])
    assert before == after, "TypeScript diagnostics changed; inspect both logs"
    print(json.dumps({"existing_type_errors": len(after), "new_type_errors": 0}))
elif sys.argv[1] == "lint":
    def diagnostics(file):
        current = ""
        result = []
        for line in Path(file).read_text().splitlines():
            if line.startswith("/app/"):
                current = line
            match = re.match(r"\s+\d+:\d+\s+error\s+(.+)", line)
            if match:
                result.append((current, match.group(1)))
        return sorted(result)
    before, after = (diagnostics(file) for file in sys.argv[2:4])
    assert before == after, f"Lint diagnostics changed: {after} versus {before}"
    print(json.dumps({"existing_lint_errors": after, "new_lint_errors": 0}))
