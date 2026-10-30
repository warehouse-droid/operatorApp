# Test environment cleanup

All test containers and databases are disposable. Remove them, their disposable
volumes, and their unused networks when the task finishes, including after a
failure or interruption. Register teardown with a shell trap or `finally` before
creating the environment. Stopping containers alone does not satisfy cleanup.
Use `docker compose down --volumes --remove-orphans` for an isolated Compose
project and `docker run --rm` for one-off containers. For manually created test
containers, remove the exact container IDs and their disposable storage.

Do not preserve test databases unless the user explicitly requests it. Generated
test artifacts, logs, coverage, browser downloads, and temporary source copies
are disposable and must be removed after the complete test run, including on
failure or interruption. Use `bash docker/run-isolated-tests.sh [test command]`
for standard Compose tests. For a custom bounded harness, wrap its full lifecycle
with `python3 docker/retention/retention.py run -- <command>` and write all
temporary output under `$MBBS_TEST_ARTIFACT_DIR`; register container teardown
inside that command. The outer runner deletes its unique artifact directory
after the command and its teardown finish. Keep only concise evidence in source
documentation and genuine operational audit records outside disposable output.
Production containers, production volumes, deployment rollback data, and
operational audit records are outside test cleanup.

Deployment-copy retention is the latest five complete copies across
`server/deployments` and `/home/ubuntu/operatorapp-deploy-backups`. Small tracked
records and files referenced by live Compose configuration are retained separately.
The hourly `operatorapp-copy-retention.timer` cleans old copies and abandoned
artifacts after a two-hour inactivity guard. Immediate test cleanup is mandatory;
the timer is recovery for interrupted/unwrapped historical runs, not a replacement.
Full database backups retain their existing five-copy policy. Never delete or
modify production Docker volumes as part of artifact retention.

On this host, the production allowlist is `mbbs-operator-app-app-1`,
`mbbs-operator-app-db-1`, `mbbs-operator-app-webhook-worker-1`, and
`mbbs-operator-app-ollama-1`. Verify after teardown that no test containers remain
in either `docker ps` or `docker ps -a`, and that production health still passes.

All test workloads on the application host must use `mbbs-tests.slice`, which
limits their combined memory to 4 GiB and CPU to two cores. Use the limits in
`docker-compose.mbt-test.yml`; manual Docker launches must also set
`--cgroup-parent=mbbs-tests.slice`, `--init`, a memory limit of at most 2 GiB,
a matching memory-plus-swap limit, a PID limit of at most 512, and explicit
tmpfs size limits. Label manual test containers `com.mbbs.lifecycle=disposable-test`.
Increase budgets only with an explicit user instruction. Never use production
credentials or production data volumes in test containers.

Install the shared budget on a new host with `docker/mbbs-tests.slice` as
`/etc/systemd/system/mbbs-tests.slice`, then reload systemd and start the slice
before launching tests. Verify the configuration with
`python3 docker/verify-memory-limits.py`.
