#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
artifact="$repo/server/test-artifacts/transfer-yard-posting-20261021"
deps="$repo/server/test-artifacts/operator-to-yard-flow-tooling"
project="mbbs-transfer-yard-test-$$"
installer="$project-dependencies"
override="$artifact/compose-$$.yml"
docker=(sudo -n docker)
compose=("${docker[@]}" compose -p "$project" -f "$repo/docker-compose.mbt-test.yml" -f "$override")
mkdir -p "$artifact" "$deps"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -f "$override" ]]; then
    "${compose[@]}" --profile tools down --volumes --remove-orphans > "$artifact/cleanup-$$.log" 2>&1 || status=1
  fi
  "${docker[@]}" rm -f "$installer" >/dev/null 2>&1 || true
  "${docker[@]}" ps --format '{{.Names}} {{.Status}}' > "$artifact/docker-running-$$.log"
  "${docker[@]}" ps -a --format '{{.Names}} {{.Status}}' > "$artifact/docker-all-$$.log"
  if rg -q "$project" "$artifact/docker-all-$$.log"; then status=1; fi
  "${docker[@]}" network ls -q --filter "label=com.docker.compose.project=$project" > "$artifact/networks-$$.log"
  "${docker[@]}" volume ls -q --filter "label=com.docker.compose.project=$project" > "$artifact/volumes-$$.log"
  [[ ! -s "$artifact/networks-$$.log" && ! -s "$artifact/volumes-$$.log" ]] || status=1
  : > "$artifact/production-health-$$.log"
  for name in mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-ollama-1; do
    health="$("${docker[@]}" inspect "$name" --format '{{.State.Health.Status}}')"
    printf '%s %s\n' "$name" "$health" >> "$artifact/production-health-$$.log"
    [[ "$health" == healthy ]] || status=1
  done
  [[ "$("${docker[@]}" inspect mbbs-operator-app-webhook-worker-1 --format '{{.State.Running}}')" == true ]] || status=1
  rm -f "$override"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$(systemctl show mbbs-tests.slice -p MemoryMax --value)" == 4294967296 ]]
[[ "$(systemctl show mbbs-tests.slice -p CPUQuotaPerSecUSec --value)" == 2s ]]
cp server/package.json server/package-lock.json "$deps/"
lock_hash="$(sha256sum server/package-lock.json | cut -d' ' -f1)"
if [[ ! -f "$deps/installed.sha256" || "$(cat "$deps/installed.sha256")" != "$lock_hash" ]]; then
  "${docker[@]}" run --rm --name "$installer" --init --cgroup-parent=mbbs-tests.slice \
    --label com.mbbs.lifecycle=disposable-test --memory=2g --memory-swap=2g --cpus=2 --pids-limit=512 \
    --tmpfs /tmp:rw,size=512m --mount "type=bind,src=$deps,dst=/deps" --workdir /deps \
    node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 \
    npm ci --no-audit --no-fund > "$artifact/dependencies.log" 2>&1
  printf '%s\n' "$lock_hash" > "$deps/installed.sha256"
fi
test_image="${TO_YARD_TEST_IMAGE:-node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0}"
if [[ -s "$artifact/browser-image-id.txt" && -z "${TO_YARD_TEST_IMAGE:-}" ]]; then test_image="$(cat "$artifact/browser-image-id.txt")"; fi
python3 - "$repo" "$override" "$test_image" <<'PY'
import json, os, pathlib, sys
root, target, image = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
candidate = pathlib.Path(os.environ['TO_YARD_CANDIDATE_ROOT']) if os.environ.get('TO_YARD_CANDIDATE_ROOT') else None
mounts = []
for directory in ['src', 'public', 'test', 'tools', 'migrations', 'contracts']:
    source = root / 'server' / directory
    if candidate and directory in ['src', 'public', 'contracts'] and (candidate / directory).exists():
        source = candidate / directory
    mounts.append(f'{source}:/app/{directory}:ro')
test_baseline = os.environ.get('TO_YARD_TEST_BASELINE_ROOT')
if test_baseline:
    for source in sorted(pathlib.Path(test_baseline).rglob('*.test.js')):
        relative = source.relative_to(test_baseline)
        assert relative.parts[:2] == ('test', 'mbt'), relative
        mounts.append(f'{source}:/app/{relative}:ro')
for name in ['package.json', 'package-lock.json', '.c8rc.json', 'eslint.mbt.config.js', 'tsconfig.mbt.json', 'Dockerfile', 'Dockerfile.test', '.env.example']:
    mounts.append(f'{root}/server/{name}:/app/{name}:ro')
mounts += [f'{root}/server/test-artifacts/operator-to-yard-flow-tooling/node_modules:/app/node_modules:ro',
           f'{root}/server/test-artifacts:/app/test-artifacts', f'{root}/.github/workflows:/workspace/.github/workflows:ro',
           f'{root}/docker-compose.yml:/workspace/docker-compose.yml:ro',
           f'{root}/docker-compose.mbt-test.yml:/workspace/docker-compose.mbt-test.yml:ro']
text = f'services:\n  test:\n    image: {json.dumps(image)}\n    build: !reset null\n    working_dir: /app\n    user: "1000:1000"\n    labels:\n      com.mbbs.lifecycle: disposable-test\n    volumes: !override\n'
text += ''.join(f'      - {json.dumps(mount)}\n' for mount in mounts)
text += '  db:\n    labels:\n      com.mbbs.lifecycle: disposable-test\n'
target.write_text(text)
PY
"${compose[@]}" --profile tools config --format json > "$artifact/compose-effective-$$.json"
"${compose[@]}" up -d --wait db > "$artifact/start-$$.log" 2>&1
"${compose[@]}" --profile tools run --rm test npm run migrate > "$artifact/migrate-$$.log" 2>&1
"${compose[@]}" --profile tools run --rm test "$@"
