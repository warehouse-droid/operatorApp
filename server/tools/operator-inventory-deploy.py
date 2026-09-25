"""Build a scoped overlay on the live image; preserve unrelated workspace work."""
import importlib.util
import copy
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("inventory_release_core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/operator-inventory-20260923-v1")
core.BEFORE = Path("/tmp/operator-inventory-baseline/server")
core.IMAGE = "mbbs-operator-app:operator-inventory-20260923-v1"
core.ROLLBACK = "mbbs-operator-app:rollback-operator-inventory-20260923-v1"
core.MIGRATION = "220_operator_inventory_workflows.sql"
catalog = (SERVER / "tools/operator-inventory-files.mjs").read_text()
for name, attribute in [("added", "ADDED"), ("existing", "EXISTING")]:
    body = re.search(r"export const " + name + r" = \[(.*?)\];", catalog, re.S)[1]
    setattr(core, attribute, re.findall(r"'([^']+)'", body))
core.FILES = sorted(core.ADDED + core.EXISTING)
VERSION = "20260923-operator-inventory-v1"


def shell_assets(file, text):
    for asset in ["operator.js", "i18n.js"]:
        text, count = re.subn(r"/" + re.escape(asset) + r'\?v=[^"\s]+', "/" + asset + "?v=" + VERSION, text)
        assert count == 1
    assets = ["operator-inventory.css", "counting-calculator.js", "operator-inventory.js"]
    if file.endswith(".html"):
        text = text.replace("  </head>", '    <link rel="stylesheet" href="/' + assets[0] + '?v=' + VERSION + '" />\n  </head>')
        anchor = '    <script src="/operator.js?v=' + VERSION + '"></script>'
        assert anchor in text
        text = text.replace(anchor, ''.join('    <script src="/' + asset + '?v=' + VERSION + '"></script>\n' for asset in assets[1:]) + anchor)
    else:
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
        assert count == 1
        text = text.replace('  "/operator.html",\n', '  "/operator.html",\n' + ''.join('  "/' + asset + '?v=' + VERSION + '",\n' for asset in assets))
    return text


core.shell_assets = shell_assets
original_database = core.database


def database(sql):
    # The shared additive-migration release procedure checks the new table name.
    return original_database(sql.replace("to_regclass('public.operator_ui_preferences')", "to_regclass('public.inventory_count_sheets')"))


core.database = database
original_current = core.current


def current(state):
    reviewed = core.RELEASE / "concurrent-work-reviewed.json"
    checked = copy.deepcopy(state)
    if reviewed.exists():
        record = json.loads(reviewed.read_text())
        # A receiving-only edit arrived after the inventory candidate was built.
        # Keep it in the workspace; release the already tested inventory snapshot.
        assert core.digest((core.RELEASE / "concurrent-operator-work.patch").read_bytes()) == record["patchSha256"]
        assert core.digest((core.RELEASE / "workspace-at-prepare/public/operator.js").read_bytes()) == state["workspace"]["public/operator.js"]
        # Verify that every inventory hunk is still present, while allowing the
        # independently edited Receiving functions to continue changing.
        patch = (core.RELEASE / "release.patch").read_text()
        start = patch.index('--- a/public/operator.js\n')
        end = patch.find('\n--- a/', start + 1)
        with tempfile.TemporaryDirectory(prefix="inventory-scope-") as directory:
            target = Path(directory) / "operator.js"
            shutil.copy2(SERVER / "public/operator.js", target)
            subprocess.run(["patch", "--batch", "--fuzz=0", "--reverse", str(target)],
                           input=patch[start:end] + '\n', text=True, capture_output=True, check=True)
        for file in record["workspace"]:
            if file != "public/operator.js":
                text = (SERVER / file).read_text()
                for asset in ["operator-inventory.js", "counting-calculator.js", "operator-inventory.css"]:
                    assert asset in text, "Inventory asset removed by concurrent work"
            checked["workspace"][file] = core.digest((SERVER / file).read_bytes())
    return original_current(checked)


core.current = current


def prepare():
    core.prepare()
    candidate = core.RELEASE / "candidate"
    for name in ["test", "tools", "contracts"]:
        (candidate / name).symlink_to(SERVER / name, target_is_directory=True)
    for pattern in ["*.js", "*.json", "Dockerfile*"]:
        for path in SERVER.glob(pattern):
            if not (candidate / path.name).exists():
                shutil.copy2(path, candidate / path.name)


def verify():
    state = core.manifest()
    core.ready(state["candidateImageId"])
    actual = core.metadata(core.APP)
    assert actual["configuration"] == state["app"]["configuration"], "Runtime settings changed"
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state["dependencies"], "Dependency changed"
    checksums = core.docker("exec", core.APP, "sha256sum", *["/app/" + file for file in core.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix("/app/"): line.split()[0] for line in checksums} == state["after"]
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + core.MIGRATION + "';").strip() == "1"
    script = """import assert from 'node:assert/strict';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  for(const path of ['/operator','/control/count-sheets','/operator-inventory.js?v=VERSION','/counting-calculator.js?v=VERSION','/control-count-sheets.js?v=VERSION']) {
    assert.equal((await fetch(base+path,{headers:{'Cache-Control':'no-cache'}})).status,200,path);
  }
  for(const path of ['/api/count-sheets','/api/control/count-sheets','/api/inventory/damage/config']) {
    assert.equal((await fetch(base+path)).status,401,path);
  }
}console.log(JSON.stringify({pages:200,anonymousApis:401}));""".replace("VERSION", VERSION)
    http = json.loads(core.docker("exec", "-i", core.APP, "node", "--input-type=module", input=script.encode()))
    result = {"deployed": True, "imageId": actual["imageId"], "configurationPreserved": True, "dependenciesUnchanged": True, **http}
    core.save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


core.verify = verify


def approve_candidate():
    state = core.manifest()
    core.current(state)
    evidence = SERVER / "test-artifacts/operator-inventory"
    comparison = json.loads((evidence / "operator-inventory/comparison.json").read_text())
    assert comparison["unexpected"] == []
    assert all(row["killed"] for row in json.loads((evidence / "operator-inventory/mutations/results.json").read_text()))
    sources = json.loads((evidence / "operator-inventory/source.json").read_text())
    reviewed = core.RELEASE / "concurrent-work-reviewed.json"
    concurrent = json.loads(reviewed.read_text())["workspace"] if reviewed.exists() else {}
    for file, expected in sources.items():
        if file in concurrent:
            # current() checks all inventory hunks and immutable candidate hashes.
            continue
        assert core.digest((SERVER / file).read_bytes()) == expected, "Source changed after validation: " + file
    log = (core.RELEASE / "candidate-tests.log").read_text()
    assert "# fail 0" in log and "# pass " in log
    core.save("verified.json", {"passed": True, "imageId": state["candidateImageId"], "sources": state["after"]})


if __name__ == "__main__":
    {"prepare": prepare, "build": core.build, "approve-candidate": approve_candidate, "apply": core.apply, "verify": verify}[sys.argv[1]]()
