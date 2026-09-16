"""Capture non-secret source before the orderLine change; preserve dirty work."""
import hashlib
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
artifact = root / "test-artifacts/order-line-storage"
snapshot = artifact / "baseline"
assert not snapshot.exists(), "Baseline already exists; do not overwrite it"
snapshot.mkdir(parents=True)
for directory in ["src", "public", "test", "tools", "migrations", "contracts"]:
    shutil.copytree(root / directory, snapshot / directory,
                    ignore=shutil.ignore_patterns("__pycache__"))
for file in root.iterdir():
    if file.is_file() and not file.name.startswith(".") and (
        file.suffix in [".json", ".js", ".md"] or file.name.startswith("Dockerfile")
    ):
        shutil.copy2(file, snapshot / file.name)
hashes = {str(file.relative_to(snapshot)): hashlib.sha256(file.read_bytes()).hexdigest()
          for file in sorted(snapshot.rglob("*")) if file.is_file()}
(artifact / "baseline-hashes.json").write_text(json.dumps(hashes, indent=2) + "\n")
print(snapshot)
