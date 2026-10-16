# Test environment cleanup

All test containers and databases are disposable. Remove them, their disposable
volumes, and their unused networks when the task finishes, including after a
failure or interruption. Register teardown with a shell trap or `finally` before
creating the environment. Stopping containers alone does not satisfy cleanup.
Use `docker compose down --volumes --remove-orphans` for an isolated Compose
project and `docker run --rm` for one-off containers. For manually created test
containers, remove the exact container IDs and their disposable storage.

Do not preserve test databases unless the user explicitly requests it. Keep
test results and diagnostic logs in the repository's existing artifact folders.
Production containers, production volumes, deployment rollback data, and
operational audit records are outside test cleanup.

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
