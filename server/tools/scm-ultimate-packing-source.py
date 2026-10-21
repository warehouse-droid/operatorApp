"""Freeze the scoped implementation, tests and executable evidence recipe."""
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / "test-artifacts/scm-ultimate-packing-20261005"
RUNTIME = ["src/smart-scm-planning-repository.js", "public/scm-smart-proposals.js", "public/scm-smart.html"]


def prepare():
    changed = {}
    for filename in RUNTIME:
        shutil.copy2(SERVER / filename, ARTIFACT / "candidate" / filename)
        original = (ARTIFACT / "baseline" / filename).read_text().splitlines()
        current = (SERVER / filename).read_text().splitlines()
        lines = []
        for operation, _i, _j, start, end in difflib.SequenceMatcher(None, original, current).get_opcodes():
            if operation in ["replace", "insert"]:
                lines.extend(range(start + 1, end + 1))
        changed[filename] = lines
    targets = set(RUNTIME)
    targets.update(str(p.relative_to(SERVER)) for p in (SERVER / "tools").glob("scm-ultimate-packing-*"))
    targets.update(str(p.relative_to(SERVER)) for p in (SERVER / "test").rglob("scm-ultimate-packing*"))
    source = {filename: hashlib.sha256((SERVER / filename).read_bytes()).hexdigest() for filename in sorted(targets) if (SERVER / filename).is_file()}
    (ARTIFACT / "changed-lines.json").write_text(json.dumps(changed, indent=2) + "\n")
    manifest = {"gitHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SERVER, text=True).strip(),
                "runtimeFiles": RUNTIME, "sourceHashes": source,
                "sourceTreeHash": hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest(),
                "fixtureHash": hashlib.sha256((ARTIFACT / "replay-input.json").read_bytes()).hexdigest()}
    (ARTIFACT / "source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"sourceTreeHash": manifest["sourceTreeHash"], "files": len(source), "runtimeFiles": RUNTIME}))


if __name__ == "__main__":
    prepare()
