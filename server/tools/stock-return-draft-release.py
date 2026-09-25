"""Prepare and release the single stock-return SQL correction over the live image."""
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "server/test-artifacts/stock-return-insert"
BASELINE = ARTIFACT / "baseline"
RELEASE = ARTIFACT / "release"
APP = "mbbs-operator-app-app-1"
FILE = "src/return-repository.js"
IMAGE = "mbbs-operator-app:stock-return-insert-20260918"
OLD = "$23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34::jsonb, $35::jsonb"
NEW = "$23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33::jsonb, $34::jsonb"


def command(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs)


def metadata():
    return json.loads(command("docker", "inspect", "--format",
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},'
        '"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', APP))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def draft_fingerprints():
    script = """import { query, closeDb } from './src/db.js';
await query('BEGIN READ ONLY');
try {
  const result = await query(`SELECT id::text, md5(payload::text) AS fingerprint
    FROM return_drafts WHERE draft_type IN ('stock','combined') AND expires_at > now() ORDER BY id`);
  console.log(JSON.stringify(result.rows));
} finally { await query('ROLLBACK'); await closeDb(); }
"""
    return json.loads(command("docker", "exec", "-i", APP, "node", "--input-type=module", input=script))


def compose(files, override):
    args = ["sudo", "-n", "docker", "compose", "-p", "mbbs-operator-app"]
    for config_file in files.split(","):
        args += ["-f", config_file]
    args += ["-f", str(override), "up", "-d", "--no-build", "--no-deps", "app"]
    subprocess.run(args, cwd=ROOT, check=True)


def health():
    for _ in range(60):
        try:
            with urlopen("http://127.0.0.1:3000/health", timeout=1) as response:
                if response.status == 200:
                    return json.load(response)
        except OSError:
            pass
        time.sleep(0.5)
    raise RuntimeError("Application health did not recover")


def prepare():
    before = (BASELINE / FILE).read_bytes()
    assert before.decode().count(OLD) == 1, "Expected exactly one faulty expression list"
    assert NEW in (ROOT / "server" / FILE).read_text(), "Workspace SQL correction is missing"
    after = before.decode().replace(OLD, NEW).encode()
    for directory in ["src", "migrations", "public"]:
        shutil.copytree(BASELINE / directory, RELEASE / directory, dirs_exist_ok=True)
    (RELEASE / FILE).write_bytes(after)
    patch = "".join(difflib.unified_diff(before.decode().splitlines(True), after.decode().splitlines(True),
        fromfile="before/" + FILE, tofile="after/" + FILE))
    (ARTIFACT / "release.patch").write_text(patch)
    runtime = json.loads((BASELINE / "runtime.json").read_text())
    stage = ARTIFACT / "image"
    (stage / "src").mkdir(parents=True, exist_ok=True)
    (stage / FILE).write_bytes(after)
    (stage / "Dockerfile").write_text("FROM " + runtime["image"] + "\nCOPY " + FILE + " /app/" + FILE + "\n")
    (ARTIFACT / "compose.release.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n")
    (ARTIFACT / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + runtime["imageId"] + "\n")
    manifest = {"runtime": runtime, "before": digest(before), "after": digest(after), "image": IMAGE}
    (ARTIFACT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(patch)


def capture():
    assert not (BASELINE / "runtime.json").exists(), "Baseline already captured"
    before = metadata()
    BASELINE.mkdir(parents=True, exist_ok=True)
    for directory in ["src", "migrations", "public"]:
        subprocess.run(["docker", "cp", APP + ":/app/" + directory, str(BASELINE / directory)], check=True)
    assert metadata() == before, "Running app changed during capture"
    assert OLD in (BASELINE / FILE).read_text(), "The current app no longer has this SQL defect"
    (BASELINE / "runtime.json").write_text(json.dumps(before, indent=2) + "\n")
    print(json.dumps({"captured": before["image"], "sourceHash": digest((BASELINE / FILE).read_bytes())}))


def build():
    manifest = json.loads((ARTIFACT / "manifest.json").read_text())
    base_id = command("docker", "image", "inspect", "--format", "{{.Id}}", manifest["runtime"]["image"]).strip()
    assert base_id == manifest["runtime"]["imageId"], "Base image tag changed since capture"
    subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", IMAGE, str(ARTIFACT / "image")], check=True)
    actual = command("docker", "run", "--rm", "--network", "none", "--entrypoint", "sha256sum", IMAGE, "/app/" + FILE).split()[0]
    assert actual == manifest["after"], "Release image source differs from verified candidate"
    base_layers = json.loads(command("docker", "image", "inspect", "--format", "{{json .RootFS.Layers}}", manifest["runtime"]["imageId"]))
    release_layers = json.loads(command("docker", "image", "inspect", "--format", "{{json .RootFS.Layers}}", IMAGE))
    assert release_layers[:-1] == base_layers, "Candidate must add exactly one file layer to the captured image"
    manifest["candidateImageId"] = command("docker", "image", "inspect", "--format", "{{.Id}}", IMAGE).strip()
    (ARTIFACT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"built": IMAGE, "sourceHash": actual}))


def apply():
    manifest = json.loads((ARTIFACT / "manifest.json").read_text())
    assert metadata() == manifest["runtime"], "Running app changed; rebase and retest before release"
    actual = command("docker", "exec", APP, "sha256sum", "/app/" + FILE).split()[0]
    assert actual == manifest["before"], "Running source changed; rebase and retest before release"
    assert (ARTIFACT / "verified.json").exists(), "Verification must pass before release"
    verified = json.loads((ARTIFACT / "verified.json").read_text())
    assert verified["sourceHash"] == manifest["after"]
    assert command("docker", "image", "inspect", "--format", "{{.Id}}", IMAGE).strip() == manifest["candidateImageId"]
    before_drafts = draft_fingerprints()
    (ARTIFACT / "drafts-before.json").write_text(json.dumps(before_drafts, indent=2) + "\n")
    try:
        compose(manifest["runtime"]["configFiles"], ARTIFACT / "compose.release.yml")
        result = health()
        actual = command("docker", "exec", APP, "sha256sum", "/app/" + FILE).split()[0]
        assert actual == manifest["after"], "Deployed source hash does not match"
    except Exception:
        compose(manifest["runtime"]["configFiles"], ARTIFACT / "compose.rollback.yml")
        health()
        raise
    after_drafts = draft_fingerprints()
    remaining = {row["id"]: row["fingerprint"] for row in after_drafts}
    unchanged = sum(remaining.get(row["id"]) == row["fingerprint"] for row in before_drafts)
    report = {"deployed": True, "image": metadata()["image"], "sourceHash": actual,
        "health": result, "draftsBefore": len(before_drafts), "unchangedDrafts": unchanged}
    (ARTIFACT / "deployment.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    {"capture": capture, "prepare": prepare, "build": build, "apply": apply}[sys.argv[1]]()
