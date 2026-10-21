"""Deploy the validated app-only conversion patch with automatic image rollback."""
from pathlib import Path
import subprocess
import sys
TASK=Path(__file__).resolve().parent
subprocess.run([sys.executable,str(TASK/'deploy.py'),'prepare'],check=True)
subprocess.run([sys.executable,str(TASK/'deploy.py'),'apply'],check=True)
