"""Record this task's changed lines relative to its preserved worktree baseline."""
import difflib
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / "test-artifacts/operator-display-fix/baseline"
FILES = [
    "public/operator.js", "public/operator-delivery-refresh.js", "public/operator.html",
    "public/service-worker.js", "src/operator-linked-quantity-domain.js", "src/delivery-repository.js",
]
manifest = []
patch = []
for filename in FILES:
    current = (ROOT / filename).read_text()
    previous = (BASELINE / filename).read_text() if (BASELINE / filename).exists() else ""
    before, after = previous.splitlines(), current.splitlines()
    # Moving an existing block into a named function changes indentation, not its statements.
    diff = difflib.SequenceMatcher(None, [line.strip() for line in before], [line.strip() for line in after], autojunk=False)
    changed = []
    for operation, _, _, start, end in diff.get_opcodes():
        if operation in ("insert", "replace"):
            changed.extend(index + 1 for index in range(start, end)
                           if after[index].strip()
                           and not after[index].lstrip().startswith(("//", "/*", "*"))
                           and not re.fullmatch(r"[\s{}();,]+", after[index]))
    manifest.append({"file": filename, "sha256": hashlib.sha256(current.encode()).hexdigest(), "lines": changed})
    patch.extend(difflib.unified_diff(previous.splitlines(True), current.splitlines(True),
                                   fromfile=f"baseline/{filename}", tofile=filename))
(ROOT / "test/support/operator-display-changes.json").write_text(json.dumps(manifest, indent=2) + "\n")
(ROOT / "test-artifacts/operator-display-fix/implementation.patch").write_text("".join(patch))
print(json.dumps({item["file"]: len(item["lines"]) for item in manifest}))
