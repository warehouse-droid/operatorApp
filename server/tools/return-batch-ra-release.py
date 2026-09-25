"""Build a focused return release over the captured running application."""
import difflib
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
ARTIFACT = SERVER / "test-artifacts/return-batch-ra"
BASE = ARTIFACT / "live-before"
RELEASE = ARTIFACT / "release"
IMAGE = "mbbs-operator-app:return-batch-ra-20260918"
FILES = ["src/return-repository.js", "src/return-netsuite.js", "src/return-ra-workflow.js",
         "src/return-batch-ra-domain.js", "src/return-batch-ra-service.js", "src/netsuite.js",
         "src/history-repository.js", "src/operator-netsuite-posting-policy.js", "src/mbt/feature-gate-catalog.js",
         "public/control.js", "public/sales.js", "public/mbt-gates.js",
         "migrations/203_operator_return_authorizations.sql", "migrations/207_return_batch_authorizations.sql"]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def function(text, name):
    start = re.search(r"^(?:async )?function " + re.escape(name) + r"\(", text, re.M).start()
    end = re.search(r"\n(?:async )?function ", text[start + 1:])
    return text[start:start + 1 + end.start()] if end else text[start:]


def prepare():
    for directory in ["src", "public", "migrations"]:
        shutil.copytree(BASE / directory, RELEASE / directory, dirs_exist_ok=True)
    for name in FILES:
        (RELEASE / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, RELEASE / name)
    # Keep unrelated operator preferences and input/UI work out of this release.
    text = (BASE / "src/server.js").read_text()
    current = (SERVER / "src/server.js").read_text()
    start, end = "const OPERATOR_RETURN_PRIVATE_KEYS", "function returnListFilters("
    text = text[:text.index(start)] + current[current.index(start):current.index(end)] + text[text.index(end):]
    (RELEASE / "src/server.js").write_text(text)
    text = (BASE / "public/operator.js").read_text()
    current = (SERVER / "public/operator.js").read_text()
    for name in ["returnLinePolicy", "renderReturnReview", "renderReturnSuccess", "renderReturnHistoryDetails",
                 "renderReturnRecordList", "renderHistoryDetail", "resetReturnWorkflow", "buildReturnPayload", "openReturnReview", "submitReturn"]:
        replacement = function(current, name)
        replacement = replacement.replace('escapeHtml(displayUnit(line.salesUom || line.sales_uom || ""))',
                                           'escapeHtml(line.salesUom || line.sales_uom || "")')
        text = text.replace(function(text, name), replacement)
    additions = ["returnNetSuiteResultLabel", "returnPostingFunctions", "returnPostingReady",
                 "loadReturnPostingPolicies", "renderReturnPostingPolicies"]
    text = text.replace("function renderReturnSuccess()", "\n\n".join(function(current, name) for name in additions)
                        + "\n\nfunction renderReturnSuccess()")
    text = text.replace('let returnValidationMessage = "";', 'let returnValidationMessage = "";\n'
                        'let returnPostingPolicies = {};\nlet returnPostingError = "";\n'
                        'let returnPostingLoading = false;\nlet returnPostingGeneration = 0;')
    text = text.replace('    if (button.dataset.action === "return-open-review") return openReturnReview();',
                        '    if (button.dataset.action === "return-open-review") return openReturnReview();\n'
                        '    if (button.dataset.action === "return-refresh-posting") {return loadReturnPostingPolicies();}')
    assert "operatorDisplaySettings" not in text
    (RELEASE / "public/operator.js").write_text(text)
    version = "20260918-return-batch-ra-v1"
    for file, asset in [("operator.html", "operator.js"), ("control.html", "control.js"), ("sales.html", "sales.js"), ("mbt-gates.html", "mbt-gates.js")]:
        text = (BASE / "public" / file).read_text()
        text = re.sub(r'/' + re.escape(asset) + r'(?:\?v=[^"\s]+)?', '/' + asset + '?v=' + version, text)
        (RELEASE / "public" / file).write_text(text)
    text = (BASE / "public/service-worker.js").read_text()
    text = re.sub(r'mbbs-yard-operator-[^"\s]+', 'mbbs-yard-operator-' + version, text, count=1)
    text = re.sub(r'/operator.js\?v=[^"\s]+', '/operator.js?v=' + version, text)
    (RELEASE / "public/service-worker.js").write_text(text)
    names = FILES + ["src/server.js", "public/operator.js", "public/operator.html", "public/control.html",
                     "public/sales.html", "public/mbt-gates.html", "public/service-worker.js"]
    patch = []
    stage = ARTIFACT / "image"
    hashes = {}
    for name in names:
        before = (BASE / name).read_text() if (BASE / name).exists() else ""
        after = (RELEASE / name).read_text()
        patch.extend(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile="before/" + name, tofile="after/" + name))
        hashes[name] = digest(after.encode())
        (stage / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / name, stage / name)
    runtime = json.loads((BASE / "runtime.json").read_text())
    (stage / "Dockerfile").write_text("FROM " + runtime["image"] + "\n" + "".join("COPY " + name + " /app/" + name + "\n" for name in names))
    (ARTIFACT / "release.patch").write_text("".join(patch))
    manifest = {"runtime": runtime, "files": hashes, "image": IMAGE}
    (ARTIFACT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (ARTIFACT / "compose.release.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n")
    (ARTIFACT / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + runtime["imageId"] + "\n")
    print(json.dumps({"prepared": IMAGE, "files": len(names)}))


def common():
    spec = importlib.util.spec_from_file_location("prior_release", SERVER / "tools/stock-return-draft-release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build():
    helper = common()
    manifest = json.loads((ARTIFACT / "manifest.json").read_text())
    assert helper.command("docker", "image", "inspect", "--format", "{{.Id}}", manifest["runtime"]["image"]).strip() == manifest["runtime"]["imageId"]
    subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", manifest["image"], str(ARTIFACT / "image")], check=True)
    manifest["candidateImageId"] = helper.command("docker", "image", "inspect", "--format", "{{.Id}}", manifest["image"]).strip()
    (ARTIFACT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def rebase():
    manifest = json.loads((ARTIFACT / "manifest.json").read_text())
    newer = ARTIFACT / "live-rebase"
    shutil.copytree(RELEASE, ARTIFACT / "release-before-rebase", dirs_exist_ok=True)
    shutil.copy2(ARTIFACT / "manifest.json", ARTIFACT / "manifest-before-rebase.json")
    conflicts = []
    for name in manifest["files"]:
        if name.endswith(".html") or name == "public/service-worker.js":
            text = (newer / name).read_text()
            if name.endswith(".html"):
                asset = Path(name).stem + ".js"
                text = re.sub(r'/' + re.escape(asset) + r'(?:\?v=[^"\s]+)?', '/' + asset + '?v=20260918-return-batch-ra-v1', text)
            else:
                text = re.sub(r'mbbs-yard-operator-[^"\s]+', 'mbbs-yard-operator-20260918-return-batch-ra-v1', text, count=1)
                text = re.sub(r'/operator.js\?v=[^"\s]+', '/operator.js?v=20260918-return-batch-ra-v1', text)
        elif not (BASE / name).exists():
            assert not (newer / name).exists() or (newer / name).read_bytes() == (RELEASE / name).read_bytes()
            text = (RELEASE / name).read_text()
        else:
            merged = subprocess.run(["git", "merge-file", "-p", str(RELEASE / name), str(BASE / name), str(newer / name)], text=True, capture_output=True)
            if merged.returncode:
                conflicts.append(name)
            text = merged.stdout
        (RELEASE / name).write_text(text)
    assert not conflicts, conflicts
    for source in newer.rglob("*"):
        if source.is_file() and str(source.relative_to(newer)) not in manifest["files"]:
            destination = RELEASE / source.relative_to(newer)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    assert "$33::jsonb, $34::jsonb" in (RELEASE / "src/return-repository.js").read_text()
    manifest["runtime"] = json.loads((ARTIFACT / "runtime-rebase.json").read_text())
    manifest.pop("candidateImageId", None)
    patch = []
    stage = ARTIFACT / "image"
    for name in manifest["files"]:
        after = (RELEASE / name).read_bytes()
        manifest["files"][name] = digest(after)
        shutil.copy2(RELEASE / name, stage / name)
        before = (newer / name).read_text() if (newer / name).exists() else ""
        patch.extend(difflib.unified_diff(before.splitlines(True), after.decode().splitlines(True), fromfile="before/" + name, tofile="after/" + name))
    (stage / "Dockerfile").write_text("FROM " + manifest["runtime"]["image"] + "\n" + "".join("COPY " + name + " /app/" + name + "\n" for name in manifest["files"]))
    (ARTIFACT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (ARTIFACT / "release.patch").write_text("".join(patch))
    (ARTIFACT / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + manifest["runtime"]["imageId"] + "\n")
    print(json.dumps({"rebasedOn": manifest["runtime"]["image"], "files": len(manifest["files"])}))


def revise():
    helper = common()
    manifest = json.loads((ARTIFACT / "manifest.json").read_text())
    current = helper.metadata()
    assert current["imageId"] == manifest["candidateImageId"], "Rebase concurrent changes first"
    prior_revision = manifest["image"].rsplit("-v", 1)[-1] if "-v" in manifest["image"] else "1"
    shutil.copy2(ARTIFACT / "manifest.json", ARTIFACT / ("manifest-v" + prior_revision + ".json"))
    manifest["runtime"] = current
    manifest["image"] = IMAGE + "-v" + str(int(prior_revision) + 1)
    manifest.pop("candidateImageId")
    stage = ARTIFACT / "image"
    for name in manifest["files"]:
        manifest["files"][name] = digest((RELEASE / name).read_bytes())
        shutil.copy2(RELEASE / name, stage / name)
    (stage / "Dockerfile").write_text("FROM " + current["image"] + "\n" + "".join("COPY " + name + " /app/" + name + "\n" for name in manifest["files"]))
    (ARTIFACT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (ARTIFACT / "compose.release.yml").write_text("services:\n  app:\n    image: " + manifest["image"] + "\n")
    (ARTIFACT / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + current["imageId"] + "\n")
    print(json.dumps({"revision": manifest["image"]}))


def apply():
    helper = common()
    manifest = json.loads((ARTIFACT / "manifest.json").read_text())
    assert helper.metadata() == manifest["runtime"], "Live application changed; rebase before deploying"
    assert (ARTIFACT / "verified.json").exists(), "Verification is required"
    assert json.loads((ARTIFACT / "verified.json").read_text())["files"] == manifest["files"]
    # Both migrations are additive; apply only these reviewed migrations.
    script = "import {query,withTransaction,closeDb} from './src/db.js';\ntry {\n"
    for name in ["203_operator_return_authorizations.sql", "207_return_batch_authorizations.sql"]:
        script += "await withTransaction(async()=>{const prior=await query('SELECT 1 FROM schema_migrations WHERE filename=$1',[" + json.dumps(name) + "]);if(!prior.rowCount){await query(" + json.dumps((SERVER / "migrations" / name).read_text()) + ");await query('INSERT INTO schema_migrations(filename) VALUES($1)',[" + json.dumps(name) + "]);}});\n"
    script += "}finally{await closeDb();}\n"
    helper.command("docker", "exec", "-i", helper.APP, "node", "--input-type=module", input=script)
    try:
        helper.compose(manifest["runtime"]["configFiles"], ARTIFACT / "compose.release.yml")
        health = helper.health()
        assert helper.metadata()["imageId"] == manifest["candidateImageId"]
        for name, expected in manifest["files"].items():
            assert helper.command("docker", "exec", helper.APP, "sha256sum", "/app/" + name).split()[0] == expected
    except Exception:
        helper.compose(manifest["runtime"]["configFiles"], ARTIFACT / "compose.rollback.yml")
        helper.health()
        raise
    (ARTIFACT / "deployment.json").write_text(json.dumps({"image": manifest["image"], "health": health, "files": manifest["files"]}, indent=2) + "\n")
    print(json.dumps({"image": manifest["image"], "health": health}))


if __name__ == "__main__":
    {"prepare": prepare, "rebase": rebase, "revise": revise, "build": build, "apply": apply}[sys.argv[1]]()
