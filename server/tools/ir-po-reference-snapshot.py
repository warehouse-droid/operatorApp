"""Build a complete non-secret pre-change source snapshot for /app test mounts."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

root = Path(__file__).resolve().parents[1]
snapshot = Path(tempfile.mkdtemp(prefix="ir-reference-baseline-"))
for directory in ["src", "public", "test", "tools", "migrations", "contracts"]:
    shutil.copytree(root / directory, snapshot / directory, ignore=shutil.ignore_patterns("__pycache__"))
for file in root.iterdir():
    if file.is_file() and not file.name.startswith(".") and (file.suffix in [".json", ".js", ".md"] or file.name.startswith("Dockerfile")):
        shutil.copy2(file, snapshot / file.name)
for change in json.loads((root / "test/ir-po-reference-changes.json").read_text()):
    file = snapshot / change["file"]
    source = file.read_text()
    assert hashlib.sha256(source.encode()).hexdigest() == change["afterSha256"]
    for group in change["groups"]:
        source = source.replace(group["after"], group["before"])
    assert hashlib.sha256(source.encode()).hexdigest() == change["beforeSha256"]
    file.write_text(source)
for file in ["test/mbt/unit/ir-po-reference.test.js", "test/mbt/integration/ir-po-reference-http.test.js"]:
    (snapshot / file).unlink()
print(snapshot)
