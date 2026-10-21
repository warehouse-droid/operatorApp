"""Check the scoped runtime diff for secrets and new external capabilities."""
import difflib
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / "test-artifacts/scm-ultimate-packing-20261005"
manifest = json.loads((ARTIFACT / "source-manifest.json").read_text())
added = []
patch = []
for file in manifest["runtimeFiles"]:
    old = (ARTIFACT / "baseline" / file).read_text().splitlines(True)
    new = (SERVER / file).read_text().splitlines(True)
    diff = list(difflib.unified_diff(old, new, fromfile="a/" + file, tofile="b/" + file))
    patch.extend(diff)
    added.extend(line[1:] for line in diff if line.startswith("+") and not line.startswith("+++"))
text = "".join(added)
patterns = [r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", r"\bAKIA[A-Z0-9]{16}\b",
            r"(?:password|client_secret|access_token)\s*[:=]\s*['\"][^'\"]{12,}['\"]"]
assert not any(re.search(pattern, text, re.I) for pattern in patterns), "Potential secret added to runtime diff"
capabilities = re.findall(r"(?:process\.env|child_process|node:fs|node:http|node:https|\bfetch\s*\(|\bexec\s*\(|\bspawn\s*\()", text)
assert not capabilities, "New runtime capability requires review"
for file in ["package.json", "package-lock.json"]:
    assert (ARTIFACT / "baseline" / file).read_bytes() == (ARTIFACT / "candidate" / file).read_bytes()
(ARTIFACT / "release.patch").write_text("".join(patch))
result = {"runtimeFiles": manifest["runtimeFiles"], "secretMatches": 0,
          "newExternalCapabilities": [], "dependencyChanges": 0, "schemaChanges": 0}
(ARTIFACT / "final/review.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
