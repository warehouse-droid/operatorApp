"""Release the verified saved-search balance integration over the captured live image."""
import atexit
import difflib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[2]
helper = importlib.util.spec_from_file_location("pallet_release", SERVER / "tools/delivery-scm-release.py")
r = importlib.util.module_from_spec(helper)
helper.loader.exec_module(r)
r.RELEASE = SERVER / "deployments/pallet-saved-search-20261020"
r.IMAGE = "mbbs-operator-app:pallet-saved-search-20261020"
r.ROLLBACK = r.IMAGE + "-rollback"
r.READ_NAME = "mbbs-pallet-saved-search-reader"
r.CHECK_NAME = "mbbs-pallet-saved-search-image-check"
FILES = ["src/config.js", "src/netsuite.js", "src/return-netsuite.js", "src/return-pallet-saved-search.js", "src/return-policy.js", "src/return-repository.js"]


def capture():
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(name) for name in r.DEPENDENCIES]
    target = r.RELEASE / "before"
    target.mkdir()
    archive = r.docker("exec", r.APP, "tar", "-cf", "-", "-C", "/app",
                       "src", "public", "migrations", "package.json", "package-lock.json")
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(target, filter="data")
    for path in target.rglob("*"):
        path.chmod(path.stat().st_mode | (0o055 if path.is_dir() else 0o044))
    assert r.metadata(r.APP) == before
    workspace_before = r.RELEASE / "workspace-before"
    workspace_before.mkdir()
    for name in FILES:
        if (SERVER / name).exists():
            saved = workspace_before / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / name, saved)
    shutil.copytree(target, r.RELEASE / "candidate")
    r.save("capture.json", {"app": before, "dependencies": dependencies,
                            "beforeTree": r.files_at(target), "capturedAt": r.now()})
    print(json.dumps({"captured": True, "imageId": before["imageId"]}), flush=True)


def stage():
    data = json.loads((r.RELEASE / "capture.json").read_text())
    patch = ""
    for name in FILES:
        saved = r.RELEASE / "workspace-before" / name
        live = r.RELEASE / "before" / name
        if live.exists():
            shutil.copy2(live, r.RELEASE / "candidate" / name)
        if saved.exists():
            patch += "".join(difflib.unified_diff(saved.read_text().splitlines(True),
                (SERVER / name).read_text().splitlines(True), fromfile="a/" + name, tofile="b/" + name, n=3))
        else:
            assert not live.exists(), name
            shutil.copy2(SERVER / name, r.RELEASE / "candidate" / name)
    r.apply_patch(r.RELEASE / "candidate", patch, "saved-search")
    tree = r.files_at(r.RELEASE / "candidate")
    changed = sorted(name for name in data["beforeTree"].keys() | tree.keys()
                     if data["beforeTree"].get(name) != tree.get(name))
    assert changed == FILES, changed
    data.update(files=FILES, candidateTree=tree,
                candidateTreeHash=r.sha(json.dumps(tree, sort_keys=True).encode()),
                workspace={name: r.sha((SERVER / name).read_bytes()) for name in FILES},
                packages={name: r.sha((r.RELEASE / "candidate" / name).read_bytes())
                          for name in ["package.json", "package-lock.json"]})
    r.save("manifest.json", data)
    changed_lines = {}
    for name in FILES:
        original = r.RELEASE / "before" / name
        before_lines = original.read_text().splitlines() if original.exists() else []
        after_lines = (r.RELEASE / "candidate" / name).read_text().splitlines()
        changed_lines[name] = [line + 1
            for tag, _, _, start, stop in difflib.SequenceMatcher(None, before_lines, after_lines).get_opcodes()
            if tag in ("replace", "insert") for line in range(start, stop)
            if after_lines[line].strip() and not after_lines[line].lstrip().startswith(("//", "/*", "*"))]
    r.save("changed-lines.json", changed_lines)
    r.current(data)
    print(json.dumps({"staged": True, "files": FILES}), flush=True)


def approve_validation():
    data = r.state()
    r.current(data)
    evidence = json.loads((SERVER / "test-artifacts/pallet-saved-search-20261020/final/results.json").read_text())
    assert evidence["passed"]
    assert evidence["sourceHashes"] == {name: data["candidateTree"][name] for name in FILES}
    r.save("validation-passed.json", {"passed": True, "candidateTreeHash": data["candidateTreeHash"],
                                    "evidence": evidence, "at": r.now()})


def gates():
    return r.sql("BEGIN READ ONLY; SELECT coalesce(json_agg(row_to_json(f) ORDER BY flag_key),'[]'::json)"
                 " FROM mbt_feature_flags f; COMMIT;")


def verify():
    data = r.state()
    r.ready(data["candidateImageId"])
    live = r.metadata(r.APP)
    assert live["imageId"] == data["candidateImageId"]
    assert live["configuration"] == data["app"]["configuration"]
    assert [r.metadata(name) for name in r.DEPENDENCIES] == data["dependencies"]
    assert json.loads(r.docker("exec", r.APP, "node", "-e", r.HASH_SCRIPT)) == data["candidateTree"]
    assert gates() == (r.RELEASE / "gates.before.json").read_text()
    r.save("deployment-result.json", {"deployed": True, "at": r.now(), "imageId": live["imageId"],
                                     "changedFiles": FILES, "configurationPreserved": True,
                                     "dependentContainersUnchanged": True, "featureGatesPreserved": True})
    print(json.dumps({"deployed": True, "imageId": live["imageId"]}), flush=True)


def apply():
    data = r.state()
    r.current(data)
    check = json.loads((r.RELEASE / "image-check.json").read_text())
    assert check["passed"] and check["imageId"] == data["candidateImageId"]
    r.config_check(data)
    r.assert_no_active_operations(r.preflight())
    active_returns = json.loads(r.sql(
        "BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SELECT json_build_object("
        "'posting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),"
        "'returnTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()"
        " AND pid<>pg_backend_pid() AND xact_start IS NOT NULL AND query ILIKE '%return_%')); COMMIT;"))
    assert not any(active_returns.values()), active_returns
    (r.RELEASE / "gates.before.json").write_text(gates())
    args = ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"]
    try:
        with (r.RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(r.compose(data, "release") + args, cwd=r.ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (r.RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(r.compose(data, "rollback") + args, cwd=r.ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data["app"]["imageId"])
        r.save("rollback-result.json", {"restoredImageId": data["app"]["imageId"], "at": r.now()})
        raise
    finally:
        r.cleanup_manual()


if __name__ == "__main__":
    if sys.argv[1] == "build":
        atexit.register(r.cleanup_manual)
    {"capture": capture, "stage": stage, "validate": approve_validation,
     "build": r.build, "apply": apply, "verify": verify}[sys.argv[1]]()
