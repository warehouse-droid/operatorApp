#!/usr/bin/env bash
set -Eeuo pipefail

mbt_mode="${1:-P1}"
case "$mbt_mode" in
  baseline|P1|P2|P3) ;;
  *)
    echo "Usage: bash tools/mbt-gauntlet.sh {baseline|P1|P2|P3}" >&2
    exit 64
    ;;
esac

mbt_server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mbt_repo_root="$(cd "$mbt_server_root/.." && pwd)"
mbt_compose="$mbt_repo_root/docker-compose.mbt-test.yml"
mbt_project="mbbs-mbt-p1-test"
mbt_artifacts="$mbt_server_root/test-artifacts"
mbt_node_image="node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0"
mbt_test_image="${mbt_project}-test:latest"
mbt_runtime_image="mbbs-mbt-p1-runtime-check:latest"
mbt_compose_command=(docker compose -p "$mbt_project" -f "$mbt_compose")
mbt_shuffle_seeds=(2026080301 2026080337 2026080399)
case "$mbt_mode" in
  baseline|P1)
    mbt_ci_phase="P1"
    mbt_ci_workflow="mbt-p1.yml"
    ;;
  P2)
    mbt_ci_phase="P2"
    mbt_ci_workflow="mbt-p2.yml"
    ;;
  P3)
    mbt_ci_phase="P3"
    mbt_ci_workflow="mbt-p3.yml"
    ;;
esac

if [[ "$mbt_project" == "mbbs-operator-app" || "$mbt_compose" == "$mbt_repo_root/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

source "$mbt_server_root/tools/mbt-gauntlet-summary.sh"
mbt_started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
mbt_failed_line="null"

cleanup_mbt_stack() {
  "${mbt_compose_command[@]}" \
    --profile tools \
    --profile runtime \
    --profile e2e \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
}

mbt_finish_gauntlet() {
  local mbt_exit_code="$1"
  local mbt_finished_at=""
  local mbt_summary_exit_code=0
  trap - EXIT ERR INT TERM
  set +e
  cleanup_mbt_stack
  mbt_finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  mbt_write_gauntlet_summary \
    "$mbt_artifacts/gauntlet-summary.json" \
    "$mbt_mode" \
    "$mbt_exit_code" \
    "$mbt_failed_line" \
    "$mbt_started_at" \
    "$mbt_finished_at"
  mbt_summary_exit_code=$?
  if (( mbt_exit_code == 0 && mbt_summary_exit_code != 0 )); then
    mbt_exit_code=$mbt_summary_exit_code
  fi
  exit "$mbt_exit_code"
}

trap 'mbt_failed_line="$LINENO"' ERR
trap 'mbt_finish_gauntlet "$?"' EXIT
trap 'mbt_failed_line="$LINENO"; exit 130' INT
trap 'mbt_failed_line="$LINENO"; exit 143' TERM

mkdir -p "$mbt_artifacts"
docker run --rm --network none \
  -v "$mbt_artifacts:/artifacts" \
  "$mbt_node_image" \
  find /artifacts -mindepth 1 -delete
docker run --rm --network none \
  -v "$mbt_artifacts:/artifacts" \
  "$mbt_node_image" \
  chmod 0777 /artifacts

echo "[gauntlet] validating isolated Compose source"
docker run --rm --network none \
  -u 1000:1000 \
  -v "$mbt_repo_root:/workspace:ro" \
  -w /workspace/server \
  "$mbt_node_image" \
  node test/support/verify-isolated-compose.mjs /workspace/docker-compose.mbt-test.yml

echo "[gauntlet] validating least-privilege CI workflow"
docker run --rm --network none \
  -u 1000:1000 \
  -v "$mbt_repo_root:/workspace:ro" \
  -w /workspace/server \
  "$mbt_node_image" \
  node test/support/verify-ci-workflow.mjs \
    "/workspace/.github/workflows/$mbt_ci_workflow" "$mbt_ci_phase"

echo "[gauntlet] exercising fail-closed change collection"
bash "$mbt_server_root/test/support/gauntlet-change-collector-harness.sh" \
  "$mbt_server_root/tools/mbt-collect-changes.sh" \
  "$mbt_server_root/test/support/scan-diff-secrets.mjs" \
  "$mbt_node_image"

echo "[gauntlet] scanning changed text for high-confidence secrets"
mbt_diff_file="$mbt_artifacts/changed-lines.patch"
mbt_untracked_file="$mbt_artifacts/untracked-paths.nul"
bash "$mbt_server_root/tools/mbt-collect-changes.sh" \
  "$mbt_repo_root" "$mbt_diff_file" "$mbt_untracked_file"
mapfile -d '' -t mbt_untracked_paths <"$mbt_untracked_file"
mbt_existing_untracked_paths=()
for mbt_changed_path in "${mbt_untracked_paths[@]}"; do
  if [[ -f "$mbt_repo_root/$mbt_changed_path" ]]; then
    mbt_existing_untracked_paths+=("$mbt_changed_path")
  fi
done
if [[ -s "$mbt_diff_file" ]] || (( ${#mbt_existing_untracked_paths[@]} > 0 )); then
  docker run --rm --network none \
    -u 1000:1000 \
    -v "$mbt_repo_root:/workspace:ro" \
    -w /workspace \
    "$mbt_node_image" \
    node server/test/support/scan-diff-secrets.mjs \
      --unified-diff server/test-artifacts/changed-lines.patch \
      "${mbt_existing_untracked_paths[@]}"
else
  echo "[gauntlet] secret scan has no changed files"
fi

echo "[gauntlet] building pinned test and production-equivalent runtime images"
"${mbt_compose_command[@]}" build test mutation app
case "$mbt_mode" in
  P3)
    echo "[gauntlet] building the browser-capable writable Phase 3 mutation image"
    "${mbt_compose_command[@]}" build mutation-p3
    ;;
esac

echo "[gauntlet] validating the installed omit-dev production dependency tree"
docker run --rm --network none "$mbt_runtime_image" npm ls --omit=dev --all

echo "[gauntlet] recreating initial disposable PostgreSQL"
cleanup_mbt_stack
"${mbt_compose_command[@]}" up -d --wait db

echo "[gauntlet] applying migrations"
"${mbt_compose_command[@]}" run --rm migrate

if [[ "$mbt_mode" == "baseline" ]]; then
  echo "[gauntlet] running the explicit legacy baseline allowlist"
  "${mbt_compose_command[@]}" run --rm baseline
  echo "[gauntlet] baseline completed"
  exit 0
fi

echo "[gauntlet] MBT tests"
"${mbt_compose_command[@]}" run --rm test npm run test:mbt

echo "[gauntlet] deterministic shuffled repetition with a fresh database per seed"
for mbt_shuffle_seed in "${mbt_shuffle_seeds[@]}"; do
  echo "[gauntlet] recreating disposable database for shuffle seed $mbt_shuffle_seed"
  "${mbt_compose_command[@]}" \
    --profile tools \
    --profile runtime \
    --profile e2e \
    down --volumes --remove-orphans
  "${mbt_compose_command[@]}" up -d --wait db
  "${mbt_compose_command[@]}" run --rm migrate
  "${mbt_compose_command[@]}" run --rm \
    -e MBT_SHUFFLE_SEED="$mbt_shuffle_seed" \
    test npm run test:mbt:shuffled
done

echo "[gauntlet] static type analysis"
"${mbt_compose_command[@]}" run --rm test npm run typecheck:mbt

echo "[gauntlet] lint and complexity budget"
"${mbt_compose_command[@]}" run --rm test npm run lint:mbt

echo "[gauntlet] legacy public JavaScript syntax"
"${mbt_compose_command[@]}" run --rm test npm run syntax:legacy

echo "[gauntlet] coverage thresholds"
"${mbt_compose_command[@]}" run --rm test npm run test:mbt:coverage

echo "[gauntlet] persisted $mbt_mode mutation set"
"${mbt_compose_command[@]}" run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  -e MBT_MUTATION_PHASE="$mbt_mode" \
  mutation
case "$mbt_mode" in
  P3)
    echo "[gauntlet] persisted Phase 3 dedicated mutation manifest"
    "${mbt_compose_command[@]}" run --rm \
      -e MBT_MUTATION_EPHEMERAL=1 \
      -e MBT_P3_MUTATION_ADMIN_URL=postgres://mbt_test:mbt_test_password@db:5432/postgres \
      mutation-p3 npm run mutate:mbt:p3:extended
    echo "[gauntlet] persisted Phase 3 browser-report boundary mutations"
    docker run --rm --network none \
      "$mbt_test_image" \
      node test/support/check-p3-gauntlet-artifact-mutations.mjs
    ;;
esac

echo "[gauntlet] dependency license allowlist"
"${mbt_compose_command[@]}" run --rm test npm run licenses:mbt

echo "[gauntlet] explicit legacy regression baseline"
"${mbt_compose_command[@]}" run --rm baseline

assert_mbt_app_health() {
  "${mbt_compose_command[@]}" exec -T app node -e \
    "fetch('http://127.0.0.1:3000/health').then(async response => { if (!response.ok) process.exit(1); console.log(await response.text()); }).catch(error => { console.error(error); process.exit(1); })"
}

echo "[gauntlet] real application startup"
"${mbt_compose_command[@]}" up -d --wait app
assert_mbt_app_health
case "$mbt_mode" in
  P1)
    "${mbt_compose_command[@]}" exec -T \
      -e MBT_PREDEPLOY_READ_ONLY=1 \
      app npm run preflight:mbt-p1-deploy
    ;;
  P2)
    echo "[gauntlet] Phase 2 migration and closed-gate deployment preflight"
    "${mbt_compose_command[@]}" exec -T \
      -e MBT_PREDEPLOY_READ_ONLY=1 \
      -e MBT_PREDEPLOY_PHASE=P2 \
      app npm run preflight:mbt-p2-deploy
    echo "[gauntlet] Phase 2 production-image endpoint/auth fail-closed smoke"
    "${mbt_compose_command[@]}" exec -T \
      -e MBT_P2_RUNTIME_SMOKE=1 \
      app node tools/mbt-predeploy-readiness.mjs
    ;;
  P3)
    echo "[gauntlet] Phase 3 migration and closed-gate deployment preflight"
    "${mbt_compose_command[@]}" exec -T \
      -e MBT_PREDEPLOY_READ_ONLY=1 \
      -e MBT_PREDEPLOY_PHASE=P3 \
      app npm run preflight:mbt-p3-deploy
    echo "[gauntlet] Phase 3 production-image endpoint/auth fail-closed smoke"
    "${mbt_compose_command[@]}" exec -T \
      -e MBT_P3_RUNTIME_SMOKE=1 \
      app node tools/mbt-predeploy-readiness.mjs
    echo "[gauntlet] restarting isolated Phase 3 application for durable-state recovery"
    "${mbt_compose_command[@]}" restart app
    "${mbt_compose_command[@]}" up -d --wait app
    assert_mbt_app_health
    echo "[gauntlet] Phase 3 post-restart migration and closed-gate deployment preflight"
    "${mbt_compose_command[@]}" exec -T \
      -e MBT_PREDEPLOY_READ_ONLY=1 \
      -e MBT_PREDEPLOY_PHASE=P3 \
      app npm run preflight:mbt-p3-deploy
    echo "[gauntlet] Phase 3 post-restart endpoint/auth fail-closed smoke"
    "${mbt_compose_command[@]}" exec -T \
      -e MBT_P3_RUNTIME_SMOKE=1 \
      app node tools/mbt-predeploy-readiness.mjs
    ;;
  baseline)
    echo "The baseline gauntlet must exit before deployment preflight." >&2
    exit 70
    ;;
esac

shopt -s nullglob globstar
mbt_e2e_files=("$mbt_server_root"/test/mbt/e2e/**/*.spec.js "$mbt_server_root"/test/mbt/e2e/**/*.spec.mjs)
if (( ${#mbt_e2e_files[@]} > 0 )); then
  echo "[gauntlet] browser E2E"
  "${mbt_compose_command[@]}" \
    --profile runtime \
    --profile e2e \
    build e2e
  "${mbt_compose_command[@]}" \
    --profile runtime \
    --profile e2e \
    run --rm e2e
  echo "[gauntlet] validating browser E2E runtime skips"
  docker run --rm --network none \
    -v "$mbt_artifacts:/app/test-artifacts:ro" \
    "$mbt_test_image" \
    node test/support/validate-playwright-report.mjs \
      test-artifacts/playwright/report.json
else
  echo "[gauntlet] SKIP browser E2E: no Phase $mbt_mode E2E specification files exist."
fi

echo "[gauntlet] source diff integrity"
git -C "$mbt_repo_root" diff --check

if [[ "${MBT_GAUNTLET_SKIP_REGISTRY_AUDIT:-0}" == "1" ]]; then
  echo "[gauntlet] SKIP registry vulnerability audit: MBT_GAUNTLET_SKIP_REGISTRY_AUDIT=1 was explicitly supplied."
else
  echo "[gauntlet] npm dependency vulnerability audit"
  docker run --rm "$mbt_test_image" npm audit --audit-level=high
fi
echo "[gauntlet] $mbt_mode completed"
