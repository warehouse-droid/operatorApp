"""Release the requested packing-summary visibility change using the scoped release checks."""
import os
from pathlib import Path
import runpy
import sys

sys.dont_write_bytecode = True
server = Path(__file__).resolve().parents[1]
base = runpy.run_path(str(server / 'tools/operator-shared-pack-balance-release.py'))
scope = base['capture'].__globals__
release = server / 'deployments/operator-hide-pack-balance-20261023'
image = 'mbbs-operator-app:operator-hide-pack-balance-20261023'
scope.update(RELEASE=release, IMAGE=image, ROLLBACK=image + '-rollback',
             FILES=['public/operator.css', 'public/operator.html', 'public/service-worker.js'])
scope['core'].RELEASE = release

if __name__ == '__main__':
    os.umask(0o077)
    commands = {name.replace('_', '-'): base[name]
                for name in ['capture', 'validate', 'build', 'image_check', 'deploy', 'verify']}
    commands[sys.argv[1]]()
