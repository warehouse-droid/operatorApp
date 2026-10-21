"""Deploy the validated migration and narrow app patch, rolling back on failure."""
from pathlib import Path
import subprocess
import sys
TASK=Path(__file__).resolve().parent
subprocess.run([sys.executable,str(TASK/'deploy.py'),'prepare'],check=True)
subprocess.run([sys.executable,str(TASK/'migrate-live.py'),'apply'],check=True)
try:
    subprocess.run([sys.executable,str(TASK/'deploy.py'),'apply'],check=True)
except BaseException:
    subprocess.run([sys.executable,str(TASK/'migrate-live.py'),'rollback'],check=True)
    raise
