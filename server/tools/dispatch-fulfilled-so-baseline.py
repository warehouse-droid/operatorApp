from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
baseline = root / 'test-artifacts/dispatch-so-fulfilled-planning/baseline'
if not (baseline / 'src/server.js').exists():
    baseline.mkdir(parents=True, exist_ok=True)
    for directory in ['src', 'public', 'migrations', 'test', 'tools']:
        shutil.copytree(root / directory, baseline / directory, dirs_exist_ok=True)
    for pattern in ['package*.json', 'tsconfig*.json', 'eslint*.js', '.c8rc.json']:
        for source in root.glob(pattern):
            shutil.copy2(source, baseline / source.name)
    subprocess.run(['patch', '-p1', '--reverse', '--input', str(root / 'test/dispatch-so-fulfilled-planning.changes.patch')], cwd=baseline, check=True)
    for source in (baseline / 'test/dispatch').rglob('*fulfilled-so*'):
        if source.is_file():
            source.unlink()
print(baseline)
