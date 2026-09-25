"""Release the PWA display/input changes over the captured live application."""
import datetime
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/operator-display-settings-20260918-v1")
BEFORE = Path("/tmp/operator-preferences-before")
APP = "mbbs-operator-app-app-1"
DEPENDENCIES = ["mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
IMAGE = "mbbs-operator-app:operator-display-settings-20260918-v1"
ROLLBACK = "mbbs-operator-app:rollback-operator-display-settings-20260918-v1"
MIGRATION = "206_operator_ui_preferences.sql"
EXISTING = ["public/operator.js", "public/operator.html", "public/i18n.js", "public/operator-load-summary.js",
            "public/driver.js", "public/driver.html", "public/service-worker.js", "public/driver-service-worker.js", "src/server.js"]
ADDED = ["public/operator-display-settings.js", "public/operator-display-settings.css", "public/operator-order-keypad.js",
         "src/operator-preferences-policy.js", "src/operator-preferences-repository.js", "src/operator-preferences-router.js",
         "migrations/" + MIGRATION]
FILES = sorted(EXISTING + ADDED)
VERSION = "20260918-operator-display-settings-v1"


def shell_assets(file, text):
    # Live HTML has an equivalent, differently ordered stylesheet list. Preserve
    # that order and all unrelated asset versions while adding this release.
    for asset in ["i18n.js", "operator-load-summary.js", "operator.js"]:
        pattern = r"/" + re.escape(asset) + r'\?v=[^"\s]+'
        text, count = re.subn(pattern, "/" + asset + "?v=" + VERSION, text)
        assert count == 1, "Unexpected asset reference: " + asset
    if file.endswith(".html"):
        text = text.replace("  </head>", '    <link rel="stylesheet" href="/operator-display-settings.css?v=' + VERSION + '" />\n  </head>')
        anchor = '    <script src="/operator.js?v=' + VERSION + '"></script>'
        text = text.replace(anchor, ''.join('    <script src="/' + asset + '?v=' + VERSION + '"></script>\n'
            for asset in ["operator-display-settings.js", "operator-order-keypad.js"]) + anchor)
    else:
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
        assert count == 1
        text = text.replace('  "/operator.html",\n', '  "/operator.html",\n' + ''.join('  "/' + asset + '?v=' + VERSION + '",\n'
            for asset in ["operator-display-settings.css", "operator-display-settings.js", "operator-order-keypad.js"]))
    return text


def docker(*args, **kwargs):
    return subprocess.check_output(["sudo", "-n", "docker", *args], **kwargs)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + "\n")


def metadata(container):
    row = json.loads(docker("inspect", container))[0]
    config = {key: row["Config"].get(key) for key in ["Cmd", "Entrypoint", "User", "WorkingDir"]}
    config["env"] = sorted(row["Config"].get("Env", []))
    config["mounts"] = sorted(row["Mounts"], key=lambda item: item["Destination"])
    config["ports"] = row["HostConfig"]["PortBindings"]
    config["restart"] = row["HostConfig"]["RestartPolicy"]
    return {"id": row["Id"], "image": row["Config"]["Image"], "imageId": row["Image"],
            "startedAt": row["State"]["StartedAt"], "configuration": digest(json.dumps(config, sort_keys=True).encode()),
            "configFiles": row["Config"]["Labels"]["com.docker.compose.project.config_files"]}


def files_at(directory):
    return {str(path.relative_to(directory)): digest(path.read_bytes())
            for folder in ["src", "public", "migrations"]
            for path in (directory / folder).rglob("*") if path.is_file()}


def manifest():
    return json.loads((RELEASE / "manifest.json").read_text())


def current(state):
    assert metadata(APP) == state["app"], "Live application changed; rebase before release"
    assert [metadata(name) for name in DEPENDENCIES] == state["dependencies"], "Dependency changed during preparation"
    for file in FILES:
        assert digest((SERVER / file).read_bytes()) == state["workspace"][file], "Workspace changed: " + file
        assert digest((RELEASE / "candidate" / file).read_bytes()) == state["after"][file], "Candidate changed: " + file
    actual = docker("exec", APP, "sha256sum", *["/app/" + file for file in EXISTING]).decode().splitlines()
    assert {line.split()[1].removeprefix("/app/"): line.split()[0] for line in actual} == {
        file: state["before"][file] for file in EXISTING}, "Live source changed since capture"


def prepare():
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    state = {"app": metadata(APP), "dependencies": [metadata(name) for name in DEPENDENCIES]}
    baseline = RELEASE / "baseline"
    baseline.mkdir()
    for folder in ["src", "public", "migrations"]:
        docker("cp", APP + ":/app/" + folder, str(baseline / folder))
    for file in ["package.json", "package-lock.json"]:
        docker("cp", APP + ":/app/" + file, str(baseline / file))
    assert metadata(APP) == state["app"], "Application changed during capture"
    candidate = RELEASE / "candidate"
    shutil.copytree(baseline, candidate)
    patch = ""
    for file in EXISTING:
        if file in ["public/operator.html", "public/service-worker.js"]:
            old = (baseline / file).read_text()
            new = shell_assets(file, old)
        else:
            old, new = (BEFORE / file).read_text(), (SERVER / file).read_text()
        patch += "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile="a/" + file, tofile="b/" + file))
    (RELEASE / "release.patch").write_text(patch)
    result = subprocess.run(["patch", "--batch", "--fuzz=0", "-p1", "-d", str(candidate)],
                            input=patch, text=True, capture_output=True)
    (RELEASE / "patch.log").write_text(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError("Patch requires review; see " + str(RELEASE / "patch.log"))
    for file in ADDED:
        assert not (baseline / file).exists(), "New file already exists: " + file
        shutil.copy2(SERVER / file, candidate / file)
    for path in candidate.rglob("*.orig"):
        path.unlink()
    base_hashes, candidate_hashes = files_at(baseline), files_at(candidate)
    changed = sorted(file for file in candidate_hashes if candidate_hashes[file] != base_hashes.get(file))
    assert changed == FILES, "Unexpected release file scope"
    state.update({"image": IMAGE, "before": {file: base_hashes.get(file) for file in FILES},
                  "after": {file: candidate_hashes[file] for file in FILES},
                  "workspace": {file: digest((SERVER / file).read_bytes()) for file in FILES},
                  "changedFiles": changed})
    stage = RELEASE / "stage"
    for file in FILES:
        (stage / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate / file, stage / file)
    (stage / "Dockerfile").write_text("FROM " + ROLLBACK + "\n" +
        "".join("COPY " + file + " /app/" + file + "\n" for file in FILES))
    (RELEASE / "compose.release.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n")
    (RELEASE / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + state["app"]["imageId"] + "\n")
    save("manifest.json", state)
    print(json.dumps({"prepared": True, "baseImage": state["app"]["image"], "files": changed}), flush=True)


def build():
    state = manifest()
    current(state)
    docker("tag", state["app"]["imageId"], ROLLBACK)
    assert docker("image", "inspect", "--format", "{{.Id}}", ROLLBACK).decode().strip() == state["app"]["imageId"]
    (RELEASE / "stage/Dockerfile").write_text("FROM " + ROLLBACK + "\n" +
        "".join("COPY " + file + " /app/" + file + "\n" for file in FILES))
    with (RELEASE / "build.log").open("wb") as output:
        subprocess.run(["sudo", "-n", "docker", "build", "--network", "none", "--pull=false", "-t", IMAGE,
                        str(RELEASE / "stage")], stdout=output, stderr=subprocess.STDOUT, check=True)
    state["candidateImageId"] = docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip()
    expected = state["after"]
    actual = docker("run", "--rm", "--network", "none", "--entrypoint", "sha256sum", IMAGE,
                    *["/app/" + file for file in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix("/app/"): line.split()[0] for line in actual} == expected
    save("manifest.json", state)
    print(json.dumps({"built": IMAGE, "imageId": state["candidateImageId"], "verifiedFiles": len(expected)}), flush=True)


def database(sql):
    return docker("exec", "-i", DEPENDENCIES[1], "psql", "-U", "mbbs_app", "-d", "mbbs_yard",
                  "-X", "-v", "ON_ERROR_STOP=1", "-At", input=sql.encode()).decode()


def compose(state, override):
    args = ["sudo", "-n", "docker", "compose", "-p", "mbbs-operator-app"]
    for file in state["app"]["configFiles"].split(","):
        args.extend(["-f", file])
    return args + ["-f", str(RELEASE / override)]


def ready(image_id):
    probe = "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"
    for _ in range(55):
        row = json.loads(docker("inspect", APP))[0]
        if row["Image"] == image_id and row["State"]["Running"] and row["RestartCount"] == 0:
            result = subprocess.run(["sudo", "-n", "docker", "exec", APP, "node", "-e", probe], capture_output=True)
            if result.returncode == 0:
                return
        time.sleep(0.5)
    raise RuntimeError("Application did not become ready")


def verify():
    state = manifest()
    ready(state["candidateImageId"])
    after = metadata(APP)
    assert after["configuration"] == state["app"]["configuration"], "Application configuration changed"
    assert [metadata(name) for name in DEPENDENCIES] == state["dependencies"], "Dependency changed"
    actual = docker("exec", APP, "sha256sum", *["/app/" + file for file in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix("/app/"): line.split()[0] for line in actual} == state["after"]
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == "1"
    assert database("SELECT to_regclass('public.operator_ui_preferences');").strip() == "operator_ui_preferences"
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
const files = FILES;
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  for (const [file, expected] of Object.entries(files)) {
    const response = await fetch(base+'/'+file.replace(/^public\\//,''), {headers:{'Cache-Control':'no-cache'}});
    assert.equal(response.status,200,file);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
  }
  const health = await fetch(base+'/health'); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
  const auth = await fetch(base+'/api/operator/preferences'); assert.equal(auth.status,401);
}
console.log(JSON.stringify({publicHealth:200,localHealth:200,publicAssetHashes:Object.keys(files).length,anonymousPreferences:401}));
""".replace("FILES", json.dumps({file: value for file, value in state["after"].items() if file.startswith("public/")}))
    http = json.loads(docker("exec", "-i", APP, "node", "--input-type=module", input=script.encode()))
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "image": IMAGE, "imageId": after["imageId"], "runtimeFilesVerified": len(FILES),
              "configurationPreserved": True, "dependenciesUnchanged": True, "migration": MIGRATION, **http}
    save("deployment-result.json", result)
    print(json.dumps(result), flush=True)
    return result


def apply():
    state = manifest()
    current(state)
    verified = json.loads((RELEASE / "verified.json").read_text())
    assert verified["imageId"] == state["candidateImageId"] and verified["passed"], "Candidate verification is required"
    assert docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip() == state["candidateImageId"]
    resolved = json.loads(subprocess.check_output(compose(state, "compose.release.yml") + ["config", "--format", "json"], cwd=ROOT))["services"]["app"]
    image_config = json.loads(docker("image", "inspect", IMAGE))[0]["Config"]
    runtime_config = json.loads(docker("inspect", APP))[0]["Config"]
    expected_env = dict(entry.split("=", 1) for entry in image_config["Env"])
    expected_env.update({key: str(value) for key, value in resolved.get("environment", {}).items()})
    assert expected_env == dict(entry.split("=", 1) for entry in runtime_config["Env"]), "Compose would change environment values"
    for field, service_key in [("Cmd", "command"), ("Entrypoint", "entrypoint"), ("User", "user"), ("WorkingDir", "working_dir")]:
        value = resolved.get(service_key)
        expected = image_config.get(field) if value is None else value
        assert expected == runtime_config.get(field), "Compose would change " + field
    # Capture an additive-migration rollback baseline without copying operational rows.
    for filename, options in [("schema-before.dump", ["--schema-only"]), ("migrations-before.dump", ["--table=public.schema_migrations"])]:
        with (RELEASE / filename).open("wb") as output:
            subprocess.run(["sudo", "-n", "docker", "exec", DEPENDENCIES[1], "pg_dump", "-U", "mbbs_app", "-d", "mbbs_yard",
                            "--format=custom", *options], stdout=output, check=True)
        with (RELEASE / filename).open("rb") as source:
            toc = docker("exec", "-i", DEPENDENCIES[1], "pg_restore", "--list", stdin=source)
        assert b"schema_migrations" in toc, "Backup did not validate"
        (RELEASE / (filename + ".toc")).write_bytes(toc)
    current(state)
    active = database("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');").strip()
    assert active == "0", "Operator posting is active; retry when idle"
    sql = (RELEASE / "candidate/migrations" / MIGRATION).read_text()
    if database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == "0":
        assert not database("SELECT to_regclass('public.operator_ui_preferences');").strip(), "Untracked preference table exists"
        result = database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + sql +
                          "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;")
        (RELEASE / "migration.log").write_text(result)
    current(state)
    assert database("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');").strip() == "0", "Operator posting started; retry when idle"
    command = ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"]
    print(json.dumps({"cutoverStarted": datetime.datetime.now(datetime.timezone.utc).isoformat()}), flush=True)
    try:
        with (RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(compose(state, "compose.release.yml") + command, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(compose(state, "compose.rollback.yml") + command, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        ready(state["app"]["imageId"])
        # Keep the additive table and any saved preferences for the next release.
        save("rolled-back.json", {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "migrationRetained": True})
        raise


if __name__ == "__main__":
    {"prepare": prepare, "build": build, "apply": apply, "verify": verify}[sys.argv[1]]()
