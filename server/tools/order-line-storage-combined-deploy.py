"""Prepare the optional combined release using the exact compatibility-tested IR fix."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

spec = importlib.util.spec_from_file_location("orderline_deploy", Path(__file__).with_name("order-line-storage-deploy.py"))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
core = deployment.core
original_release = core.RELEASE
core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/order-line-storage-ir-20260916-v3")
core.IMAGE = "mbbs-operator-app:order-line-storage-ir-20260916-v3"
ir_file = "src/operator-netsuite-posting-targets.js"
core.FILES = sorted([*core.FILES, ir_file])
original_gate = deployment.source_gate


def source_gate():
    before, after = original_gate()
    compat = json.loads((deployment.artifact / "compatibility.json").read_text())
    digest = compat["hashes"][ir_file]
    assert hashlib.sha256((core.SERVER / ir_file).read_bytes()).hexdigest() == digest, "IR fix changed after compatibility tests"
    assert json.loads((core.SERVER / "test-artifacts/sn1400625-receiving/summary.json").read_text())["sourceSha256"] == digest
    before[ir_file] = hashlib.sha256((deployment.artifact / "baseline" / ir_file).read_bytes()).hexdigest()
    after[ir_file] = digest
    return before, after


def prepare():
    core.RELEASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert not (core.RELEASE / "manifest.json").exists(), "Already prepared"
    own = json.loads((original_release / "manifest.json").read_text())
    before = json.loads((original_release / "containers.before.private.json").read_text())
    assert [row["Id"] for row in core.inspect(*core.SERVICES, *core.DEPENDENCIES)] == [row["Id"] for row in before]
    expected_before, expected_after = source_gate()
    for service in core.SERVICES:
        assert core.hashes(service) == expected_before
    stage = core.RELEASE / "image"
    (stage / "src").mkdir(parents=True, exist_ok=True)
    shutil.copy2(core.SERVER / ir_file, stage / ir_file)
    assert core.inspect(own["image"])[0]["Id"] == own["imageId"]
    (stage / "Dockerfile").write_text(f"FROM {own['image']}\nCOPY --chown=node:node {ir_file} /app/{ir_file}\n")
    with (core.RELEASE / "build.log").open("wb") as output:
        subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", core.IMAGE, str(stage)], stdout=output, stderr=subprocess.STDOUT, check=True)
    image_id = core.inspect(core.IMAGE)[0]["Id"]
    inventory = core.image_files(image_id)
    previous_inventory = json.loads((original_release / "candidate-files.json").read_text())
    assert sorted(file for file in inventory.keys() | previous_inventory.keys() if inventory.get(file) != previous_inventory.get(file)) == [ir_file]
    assert {file: inventory[file] for file in core.FILES} == expected_after
    compat = Path(json.loads((deployment.artifact / "compatibility.json").read_text())["candidate"])
    for file, digest in inventory.items():
        if file.startswith(("src/", "public/", "migrations/")) or file in ["package.json", "package-lock.json"]:
            assert hashlib.sha256((compat / file).read_bytes()).hexdigest() == digest, file
    core.save("containers.before.private.json", before)
    core.save("candidate-files.json", inventory)
    for image, name in [(core.IMAGE, "compose.release.yml"), (core.ROLLBACK, "compose.rollback.yml")]:
        (core.RELEASE / name).write_text(f"services:\n  app:\n    image: {image}\n  webhook-worker:\n    image: {image}\n")
    core.config_gate(before, core.compose(before, "compose.release.yml"), image_id)
    core.candidate_smoke(image_id)
    core.save("manifest.json", {**own, "image": core.IMAGE, "imageId": image_id, "before": expected_before,
              "after": expected_after, "changedFiles": core.FILES, "irCompatibilityHash": expected_after[ir_file]})
    print(json.dumps({"prepared": core.IMAGE, "imageId": image_id, "includesVerifiedIrFix": True}), flush=True)


core.source_gate = source_gate

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "verify"])
    mode = parser.parse_args().mode
    if mode == "prepare":
        prepare()
    elif mode == "apply":
        deployment.regression_gate()
        assert "# pass 74\n" in (deployment.artifact / "ir-compatibility.log").read_text()
        core.cutover()
    else:
        print(json.dumps(deployment.verify()))
