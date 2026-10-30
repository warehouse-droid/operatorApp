"""Disposable, bounded checks against the live source plus the task overlay."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
FILES = ["src/operator-order-reopen-repository.js", "src/local-sales-order-reopen.js",
         "public/control-order-reopen.js", "public/control.html"]
APP = "mbbs-operator-app-app-1"


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def docker(*args):
    return subprocess.check_output(["docker", *args])


def main():
    if not os.environ.get("MBBS_TEST_ARTIFACT_DIR"):
        os.execvp("python3", ["python3", str(ROOT / "docker/retention/retention.py"),
                              "run", "--", "python3", __file__, *sys.argv[1:]])
    mode = sys.argv[1] if len(sys.argv) > 1 else "final"
    artifact = Path(os.environ["MBBS_TEST_ARTIFACT_DIR"])
    artifact.chmod(0o777)
    project = f"mbbs-reopen-{os.getpid()}"
    override = artifact / "compose.json"
    compose = ["docker", "compose", "-p", project, "-f", str(ROOT / "docker-compose.mbt-test.yml"),
               "-f", str(override)]
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
    try:
        run(["python3", str(ROOT / "docker/verify-memory-limits.py")])
        baseline = artifact / "baseline"
        candidate = artifact / "candidate"
        baseline.mkdir()
        image = docker("inspect", "--format", "{{.Image}}", APP).decode().strip()
        for name in ["src", "public", "migrations", "package.json", "package-lock.json"]:
            docker("cp", f"{APP}:/app/{name}", str(baseline / name))
        assert image == docker("inspect", "--format", "{{.Image}}", APP).decode().strip()
        shutil.copytree(baseline, candidate)
        shutil.copyfile(SERVER / ".c8rc.json", candidate / ".c8rc.json")
        for name in ["tools", "test", "test-artifacts"]:
            (candidate / name).mkdir()
        if mode != "red":
            for name in FILES:
                shutil.copyfile(SERVER / name, candidate / name)
        mounts = [{"type": "bind", "source": str(candidate), "target": "/app"}]
        mounts += [
            {"type": "bind", "source": str(SERVER / "test"), "target": "/app/test", "read_only": True},
            {"type": "bind", "source": str(artifact), "target": "/app/test-artifacts"},
            {"type": "bind", "source": str(SERVER / "tools/control-local-only-reopen-checks.mjs"),
             "target": "/app/tools/control-local-only-reopen-checks.mjs", "read_only": True},
        ]
        service = {"image": "mbbs-operator-app:dispatch-editor-control-browser-test-20261015",
                   "working_dir": "/app", "entrypoint": [], "user": f"{os.getuid()}:{os.getgid()}",
                   "volumes": mounts, "environment": {"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"},
                   "labels": {"com.mbbs.lifecycle": "disposable-test"}}
        override.write_text(json.dumps({"services": {"test": service, "migrate": service,
                            "db": {"labels": {"com.mbbs.lifecycle": "disposable-test"}}}}))
        run(["docker", "run", "--rm", "--name", project + "-toolchain", "--init",
             "--cgroup-parent=mbbs-tests.slice", "--memory=2g", "--memory-swap=2g", "--cpus=2", "--pids-limit=512",
             "--label=com.mbbs.lifecycle=disposable-test", f"--label=com.mbbs.task={project}",
             "--read-only", "--tmpfs=/tmp:rw,size=512m", "--user", f"{os.getuid()}:{os.getgid()}",
             "--mount", f"type=bind,src={candidate},dst=/app", "--workdir=/app",
             service["image"], "npm", "ci", "--cache=/tmp/npm", "--no-audit", "--no-fund"])
        run(compose + ["up", "-d", "--wait", "db"], cwd=ROOT)
        with (artifact / "migrate.log").open("w") as log:
            result = subprocess.run(compose + ["run", "--rm", "--no-deps", "-T", "migrate"],
                                    cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            print((artifact / "migrate.log").read_text()[-5000:], flush=True)
            raise RuntimeError("Disposable migration failed")
        run(compose + ["run", "--rm", "--no-deps", "-T", "test", "node",
                       "tools/control-local-only-reopen-checks.mjs", mode], cwd=ROOT)
    finally:
        leftover = docker("ps", "-aq", "--filter", f"label=com.mbbs.task={project}").decode().split()
        if leftover:
            docker("rm", "-f", "-v", *leftover)
        if override.exists():
            run(compose + ["down", "--volumes", "--remove-orphans"], cwd=ROOT)
        for args in [("ps",), ("ps", "-a")]:
            print(docker(*args, "--format", "{{.Names}} {{.Status}}").decode(), flush=True)
        for resource, flag in [("ps", "-aq"), ("volume", None), ("network", None)]:
            args = [resource, flag] if flag else [resource, "ls", "-q"]
            assert not docker(*args, "--filter", f"label=com.docker.compose.project={project}").strip()
        run(["curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:3000/health"])
        print("Cleanup verified: no project containers, volumes or networks; production healthy.", flush=True)
    if mode == "final":
        summary = json.loads((artifact / "summary.json").read_text())
        summary.update({"baseImage": image, "cleanup": "removed containers, volumes and networks; production healthy"})
        (SERVER / "test/control-local-only-reopen-evidence.json").write_text(json.dumps(summary, indent=2) + "\n")


if __name__ == "__main__":
    main()
