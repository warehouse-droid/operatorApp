"""Release only the single-row top bar and settings navigation correction."""
import importlib.util
from pathlib import Path
import re
import sys

spec = importlib.util.spec_from_file_location("display_release", Path(__file__).with_name("operator-display-settings-deploy.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/operator-topbar-20260918-v2")
core.BEFORE = Path("/tmp/operator-topbar-before")
core.IMAGE = "mbbs-operator-app:operator-topbar-20260918-v2"
core.ROLLBACK = "mbbs-operator-app:rollback-operator-topbar-20260918-v2"
core.EXISTING = ["public/operator.js", "public/operator.html", "public/service-worker.js",
                 "public/operator-display-settings.js", "public/operator-display-settings.css"]
core.ADDED = []
core.FILES = sorted(core.EXISTING)
core.VERSION = "20260918-operator-topbar-v2"


def shell_assets(file, text):
    for asset in ["operator.js", "operator-display-settings.js", "operator-display-settings.css"]:
        text, count = re.subn(r"/" + re.escape(asset) + r'\?v=[^"\s]+', "/" + asset + "?v=" + core.VERSION, text)
        assert count == 1, "Unexpected reference: " + asset
    if file.endswith("service-worker.js"):
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + core.VERSION + '";', text)
        assert count == 1
    return text


core.shell_assets = shell_assets

if __name__ == "__main__":
    {"prepare": core.prepare, "build": core.build, "apply": core.apply, "verify": core.verify}[sys.argv[1]]()
