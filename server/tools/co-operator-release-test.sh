#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0"
fi
project="mbbs-co-release-$$"
overlay="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$overlay")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$overlay" ]]; then "${compose[@]}" down --volumes --remove-orphans || result=1; fi
  for name in "$project-deps" "$project-image"; do
    if docker container inspect "$name" >/dev/null 2>&1; then docker rm -fv "$name" || result=1; fi
  done
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ||
        -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ||
        -n "$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ]]; then result=1; fi
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
python3 docker/verify-memory-limits.py
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
docker run --rm --name "$project-deps" --init --cgroup-parent=mbbs-tests.slice --network none \
  --label com.mbbs.lifecycle=disposable-test --memory=512m --memory-swap=512m --cpus=1 --pids-limit=128 \
  --read-only --tmpfs /tmp:rw,size=32m --entrypoint tar mbbs-mbt-p1-test-test:latest \
  -cf - -C /app node_modules | tar -xf - -C "$MBBS_TEST_ARTIFACT_DIR"
python3 - "$repo_dir" "$overlay" "$project" <<'PY'
import importlib.util,json,os,pathlib,sys
root,overlay,project=sys.argv[1:];root=pathlib.Path(root)
spec=importlib.util.spec_from_file_location('co_release',root/'server/tools/co-operator-release.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
data=r.core.state();r.current(data)
actual=json.loads(r.core.bounded(data['candidateImageId'],project+'-image','node','-e',r.core.HASH_SCRIPT))
assert actual==data['candidateTree'], 'Built runtime differs from expected files'
artifact=pathlib.Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
mounts=[f'{root}/server/{name}:/app/{name}:ro' for name in ['test','tools','eslint.mbt.config.js','.c8rc.json']]
mounts += [f'{artifact}/node_modules:/app/node_modules:ro',f'{artifact}:/app/test-artifacts']
service={'image':data['candidateImageId'],'working_dir':'/app','user':'1000:1000','volumes':mounts,
         'labels':{'com.mbbs.lifecycle':'disposable-test'}}
pathlib.Path(overlay).write_text(json.dumps({'services':{'test':service,'migrate':service,
  'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}}))
PY
"${compose[@]}" up -d --wait db
"${compose[@]}" run --rm --no-deps -T migrate npm run migrate > "$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1 || { tail -60 "$MBBS_TEST_ARTIFACT_DIR/migrate.log"; exit 1; }
"${compose[@]}" run --rm --no-deps -T test node tools/co-operator-gauntlet.mjs
python3 - "$repo_dir" <<'PY'
import datetime,json,pathlib,sys
release=pathlib.Path(sys.argv[1])/'server/deployments/co-operator-20261027'
data=json.loads((release/'manifest.json').read_text())
record={'passed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'candidateTreeHash':data['candidateTreeHash'],'imageId':data['candidateImageId']}
(release/'validation-passed.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
PY
