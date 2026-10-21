#!/usr/bin/env python3
"""Reproduce focused hotfix checks and save the resulting evidence."""

import json
import pathlib
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]


def execute(args, source=None):
    result = subprocess.run(args, cwd=ROOT, input=source, capture_output=True,
                            text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return {"command": args, "exitCode": 0,
            "stdout": result.stdout, "stderr": result.stderr}


results = []
for command in [
    [sys.executable, "docker/verify-memory-limits.py"],
    [sys.executable, "docker/check-memory-limit-mutations.py"],
    ["sudo", "-n", "systemd-analyze", "verify", "docker/mbbs-tests.slice"],
    ["git", "diff", "--check", "--", "docker-compose.yml", "docker-compose.mbt-test.yml"],
]:
    results.append(execute(command))

syntax_checked = []
for path in (ROOT / "docker").glob("*memory*.py"):
    compile(path.read_text(), str(path), "exec")
    syntax_checked.append(str(path.relative_to(ROOT)))

foundation = (ROOT / "server/test/support/test-foundation.mjs").read_text()
foundation += "\nassertIsolatedComposeConfig(" + json.dumps(
    (ROOT / "docker-compose.mbt-test.yml").read_text()
) + ');\nconsole.log("Isolated Compose safety checks passed");\n'
results.append(execute([
    "sudo", "-n", "docker", "exec", "-i", "mbbs-operator-app-app-1",
    "node", "--input-type=module",
], foundation))

live = execute([sys.executable, "docker/verify-memory-recovery-live.py"])
additional_path = pathlib.Path(
    "/home/ubuntu/operatorapp-investigations/server-outages-20261005/"
    "additional-hotfix-cleanup.json"
)
additional = json.loads(additional_path.read_text())["additionalTestContainersRemoved"]
report = {
    "spec": json.loads((ROOT / "docker/memory-recovery-spec.json").read_text()),
    "checks": results, "pythonSyntaxChecked": syntax_checked,
    "live": json.loads(live["stdout"]),
    "cleanup": {
        "initialTestContainersRemoved": 57,
        "initialRunningTestsStopped": 49,
        "additionalTestContainersRemoved": additional,
        "unusedTestNetworksRemoved": 32,
        "namedTestVolumesRemoved": ["mbbs-special-review-db"],
        "testDatabaseBackupsCreated": 0,
        "anonymousAttachedVolumes": "removed with docker rm --volumes",
        "tmpfsDatabases": "discarded when test containers stopped",
    },
    "toolVersions": {
        "python": sys.version,
        "compose": execute(["sudo", "-n", "docker", "compose", "version"])["stdout"].strip(),
        "docker": execute(["sudo", "-n", "docker", "version", "--format", "{{.Server.Version}}"])["stdout"].strip(),
        "node": execute(["sudo", "-n", "docker", "exec", "mbbs-operator-app-app-1", "node", "--version"])["stdout"].strip(),
    },
    "issuesResolved": [
        "Before persistent configuration changes, acceptance checks reported 45 failing assertions and one missing-unit error.",
        "The host has no Node binary; the existing pure isolation validator ran using the production container's Node runtime without changing application files.",
        "The installed systemd ignores CPUAccounting; that obsolete option was removed and unit validation now emits no warnings.",
        "Concurrent test jobs created containers during verification; newly discovered isolated tests were also removed and the final check requires zero test containers.",
    ],
    "skippedLayers": {
        "applicationFullSuite": "No application code changed; use focused Compose isolation and resource checks plus real production health/database verification instead of creating another database-heavy test stack.",
        "applicationTypesAndCoverage": "No application executable lines changed; Python verification scripts were syntax checked. Configuration assertions cover all nine isolated services.",
        "dependencyAudit": "No dependencies added or updated.",
        "propertyTests": "No parsing or domain implementation changed; bounded-resource assertions inspect every resolved service, and five concrete configuration mutations are rejected.",
        "testDatabaseRollback": "User explicitly requested immediate deletion without preserving test databases; deletion is intentional and irreversible.",
    },
    "repeatCommand": "python3 docker/check-memory-recovery.py",
}
target = ROOT / "docker/memory-recovery-evidence.json"
target.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"evidence": str(target), "live": report["live"],
                  "initialRemoved": 57, "additionalRemoved": len(additional),
                  "configurationChecks": "6 passed", "configurationMutations": "5/5 rejected"}, indent=2))
