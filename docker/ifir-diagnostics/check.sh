#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export IFIR_TEST_SERVER_ROOT="${IFIR_TEST_SERVER_ROOT:-$repo_dir/server}"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
project="mbbs-ifir-diagnostics-$$"
python_container="$project-python"
dependencies_container="$project-dependencies"
overlay="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$overlay")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$overlay" ]]; then "${compose[@]}" down --volumes --remove-orphans || result=1; fi
  docker rm -f "$python_container" >/dev/null 2>&1 || true
  docker rm -f "$dependencies_container" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] || result=1
  [[ -z "$(docker ps -aq --filter "name=^/$python_container$")" ]] || result=1
  [[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]] || result=1
  [[ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ]] || result=1
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "${1:-}" == python ]]; then
  shift
  docker run --rm --init --name "$python_container" --label com.mbbs.lifecycle=disposable-test \
    --cgroup-parent=mbbs-tests.slice --cpus=1 --memory=256m --memory-swap=256m --pids-limit=64 \
    --network=none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --mount "type=bind,src=$repo_dir/docker/ifir-diagnostics,dst=/suite,readonly" \
    --workdir /suite -e PYTHONDONTWRITEBYTECODE=1 \
    python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4 \
    python -B "$@"
else
  # Read source only, never environment files or application data. Used to
  # distinguish existing type/lint findings from this disabled candidate.
  python3 - "$repo_dir/docker/ifir-diagnostics/changed.json" "$MBBS_TEST_ARTIFACT_DIR" <<'PY'
import json,os,pathlib,shutil,subprocess,sys
for relative in json.load(open(sys.argv[1])):
    destination=pathlib.Path(sys.argv[2])/'deployed-before'/relative
    destination.parent.mkdir(parents=True,exist_ok=True)
    baseline=pathlib.Path(os.environ['IFIR_TEST_BASELINE_ROOT'])/relative if os.environ.get('IFIR_TEST_BASELINE_ROOT') else None
    if baseline and baseline.exists():
        shutil.copy2(baseline,destination)
    elif relative == 'netsuite-ifir-posting-restlet.js':
        destination.write_bytes(subprocess.check_output(['git','show',f'HEAD:server/{relative}']))
    elif relative == 'src/netsuite.js':
        # Preserve unrelated pending reader changes; undo only our client option.
        source=(pathlib.Path(os.environ['IFIR_TEST_SERVER_ROOT'])/relative).read_text()
        addition='    quantityPolicyEnabled: config.netsuite.ifirPostingQuantityPolicyEnabled,\n'
        assert source.count(addition)==1
        destination.write_text(source.replace(addition,''))
    else:
        subprocess.run(['docker','cp',f'mbbs-operator-app-app-1:/app/{relative}',str(destination)],check=True)
PY
  mkdir -p "$MBBS_TEST_ARTIFACT_DIR/tooling"
  cp "$IFIR_TEST_SERVER_ROOT/package.json" "$IFIR_TEST_SERVER_ROOT/package-lock.json" "$MBBS_TEST_ARTIFACT_DIR/tooling/"
  docker run --rm --init --name "$dependencies_container" --label com.mbbs.lifecycle=disposable-test \
    --cgroup-parent=mbbs-tests.slice --cpus=1 --memory=512m --memory-swap=512m --pids-limit=128 \
    --user "$(id -u):$(id -g)" \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --mount "type=bind,src=$MBBS_TEST_ARTIFACT_DIR/tooling,dst=/tooling" --workdir /tooling \
    -e npm_config_cache=/tmp/npm-cache -e npm_config_update_notifier=false \
    node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 \
    npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
  python3 - "$repo_dir" "$overlay" <<'PY'
import json,os,sys
root,dest=sys.argv[1:]
source=os.environ['IFIR_TEST_SERVER_ROOT']
volumes=[f'{source}/{p}:/app/{p}:ro' for p in ('src','public','migrations','package.json')]
volumes += [f'{root}/server/{p}:/app/{p}:ro' for p in
 ('test','contracts','.env.example','netsuite-ifir-posting-restlet.js')]
volumes += [f'{root}/docker/ifir-diagnostics:/diagnostics:ro',
            f'{os.environ["MBBS_TEST_ARTIFACT_DIR"]}/tooling/node_modules:/app/node_modules:ro',
            f'{os.environ["MBBS_TEST_ARTIFACT_DIR"]}:/app/test-artifacts']
with open(dest,'w') as f:json.dump({'services':{'test':{'volumes':volumes,
 'image':os.environ.get('IFIR_TEST_IMAGE','mbbs-operator-app:dispatch-editor-control-browser-test-20261015'),
 'working_dir':'/app',
 'user':f'{os.getuid()}:{os.getgid()}',
 'labels':{'com.mbbs.lifecycle':'disposable-test'}}}},f)
PY
  chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
  if (( $# == 0 )); then set -- node /diagnostics/gauntlet.mjs; fi
  "${compose[@]}" run --rm --no-deps -T test "$@"
  if [[ -n "${IFIR_TEST_RELEASE_DIR:-}" ]]; then
    python3 - "$IFIR_TEST_RELEASE_DIR" "$MBBS_TEST_ARTIFACT_DIR" <<'PY'
import datetime,hashlib,json,pathlib,sys
release,artifacts=map(pathlib.Path,sys.argv[1:])
manifest=json.loads((release/'manifest.json').read_text())
report=json.loads((artifacts/'gauntlet/report.json').read_text())
for name in manifest['files']:
    digest=hashlib.sha256((release/'candidate'/name).read_bytes()).hexdigest()
    assert digest==report['source'][name]==manifest['candidateTree'][name]
record={'passed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'candidateTreeHash':manifest['candidateTreeHash'],'source':report['source'],
    'commands':report['commands'],'types':report['types'],'lint':report['lint'],
    'changedCoverage':report['changedCoverage'],'mutations':report['mutations']}
(release/'validation-passed.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'releaseValidationRecorded':True,'candidateTreeHash':record['candidateTreeHash']}))
PY
  fi
fi
