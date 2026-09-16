"""Recover the comparison baseline from the task patch when artifacts are absent."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/split-inbound-completion'
patch = root / 'test/split-inbound-completion.changes.patch'
files = [line.removeprefix('+++ b/server/') for line in patch.read_text().splitlines()
         if line.startswith('+++ b/server/')]
assert files and all('..' not in Path(file).parts for file in files)
baseline = artifact / 'baseline'
if not all((baseline / file).exists() for file in files):
    artifact.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='split-inbound-completion-baseline-') as folder:
        staged = Path(folder)
        for file in files:
            target = staged / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / file, target)
        subprocess.run(['git', 'apply', '--reverse', '-p2', str(patch)], cwd=staged, check=True)
        for file in files:
            target = baseline / file
            target.parent.mkdir(parents=True, exist_ok=True)
            if (staged / file).exists():
                shutil.copy2(staged / file, target)
            else:
                target.write_text('')
