"""Copy this task's final validation tools into the frozen runtime snapshot."""
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
target = root / 'test-artifacts/direct-ship-deployment-20260926-v2/source'
assert target.is_dir()
for pattern in ['tools/direct-ship*', 'test/dispatch/**/direct-ship*', 'test/direct-ship*']:
    for source in root.glob(pattern):
        if source.is_file():
            destination = target / source.relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
