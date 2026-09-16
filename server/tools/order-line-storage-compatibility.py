"""Freeze a combined test candidate without modifying the other thread's files."""
import hashlib
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
artifact = root / "test-artifacts/order-line-storage"
release = Path("/home/ubuntu/operatorapp-deploy-backups/order-line-storage-20260916-v3")
candidate = release / "candidate"
combined = release / "compatibility"
assert not combined.exists(), "Do not overwrite a candidate while its tests are running"
changes = json.loads((artifact / "changes.json").read_text())
for row in changes:
    if not row["file"].startswith(("src/", "migrations/")):
        target = candidate / row["file"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / row["file"], target)
shutil.copytree(candidate, combined)
other_files = ["src/operator-netsuite-posting-targets.js", "test/mbt/integration/sn1400625-receiving.test.js"]
for file in other_files:
    shutil.copy2(root / file, combined / file)
files = [row["file"] for row in changes] + other_files
hashes = {file: hashlib.sha256((combined / file).read_bytes()).hexdigest() for file in files}
(artifact / "compatibility.json").write_text(json.dumps({"candidate": str(combined), "otherThreadFiles": other_files, "hashes": hashes}, indent=2) + "\n")
print(combined)
