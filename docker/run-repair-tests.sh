#!/usr/bin/env bash
set -Eeuo pipefail
repair_repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
 exec python3 "$repair_repo/docker/retention/retention.py" run -- bash "$0" "$@"
fi
repair_project="mbbs-repair-tests-$$"
repair_override="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose --profile tools --profile e2e --profile runtime -p "$repair_project" -f "$repair_repo/docker-compose.mbt-test.yml" -f "$repair_override")
finish_repair_tests(){
 result=$?;trap - EXIT INT TERM
 "${compose[@]}" down --volumes --remove-orphans || result=1
 docker ps --format '{{.Names}} {{.Status}}'
 docker ps -a --format '{{.Names}} {{.Status}}'
 if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$repair_project")" || -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$repair_project")" || -n "$(docker network ls -q --filter "label=com.docker.compose.project=$repair_project")" ]]; then result=1;fi
 # Another authorized release can restart the shared app during test teardown.
 # Require recovery within 30 seconds while still removing every test resource.
 curl -fsS --max-time 3 --retry 15 --retry-delay 1 --retry-max-time 30 --retry-connrefused --retry-all-errors -o /dev/null http://127.0.0.1:3000/health || result=1
 exit "$result"
}
trap finish_repair_tests EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
repair_source_mount=false
if [[ "${1:-}" == '--source' ]]; then repair_source_mount=true; shift; fi
python3 - "$repair_override" "$repair_source_mount" "$repair_repo" <<'PY'
import json,os,sys
directory=os.environ['MBBS_TEST_ARTIFACT_DIR']
services={name:{'volumes':[{'type':'bind','source':directory,'target':'/app/test-artifacts'}],'labels':{'com.mbbs.lifecycle':'disposable-test'}} for name in ('migrate','e2e')}
services['db']={'labels':{'com.mbbs.lifecycle':'disposable-test'}}
services['e2e']['environment']={'REPAIR_FLOW_PREVIEW':os.environ.get('REPAIR_FLOW_PREVIEW','')}
if os.environ.get('REPAIR_TEST_IMAGE'):
    services['e2e']['image']=os.environ['REPAIR_TEST_IMAGE']
if sys.argv[2]=='true':
    # Read-only source files only: never mount the repository root, .env, or data.
    runtime=os.environ.get('REPAIR_TEST_RUNTIME',os.path.join(sys.argv[3],'server'))
    for name in ('migrate','e2e'):
        for item in ('src','public','test','tools','migrations','eslint.repair.config.js'):
            source=runtime if item in ('src','public','migrations') else os.path.join(sys.argv[3],'server')
            services[name]['volumes'].append({'type':'bind','source':os.path.join(source,item),'target':'/app/'+item,'read_only':True})
with open(sys.argv[1],'w') as f:json.dump({'services':services},f)
PY
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
cd "$repair_repo"
if [[ -n "${REPAIR_TEST_DIFF:-}" ]]; then
 cp -- "$REPAIR_TEST_DIFF" "$MBBS_TEST_ARTIFACT_DIR/repair-integration.diff"
else
git -c safe.directory="$repair_repo" diff --no-ext-diff --no-color --unified=0 -- \
 server/src/auth-repository.js server/src/config.js server/src/server.js server/src/netsuite.js \
 server/src/dispatch-plan-repository.js server/src/driver-repository.js server/src/photo-upload.js \
 server/src/photo-archive-repository.js server/public/mbr/domain.js server/public/staff-login-routes.js \
 server/public/login.js server/public/control.js server/public/app-sidebar.js server/public/operator.js \
 server/public/operator.html server/public/service-worker.js server/public/driver.js \
 server/public/driver.html server/public/driver-service-worker.js >"$MBBS_TEST_ARTIFACT_DIR/repair-integration.diff"
fi
python3 docker/verify-memory-limits.py
if [[ "$repair_source_mount" == false ]]; then
 if ! "${compose[@]}" build migrate e2e >"$MBBS_TEST_ARTIFACT_DIR/build.log" 2>&1; then tail -n 70 "$MBBS_TEST_ARTIFACT_DIR/build.log";exit 1;fi
fi
"${compose[@]}" up -d --wait db
if ! "${compose[@]}" run --rm --no-deps -T migrate >"$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1; then tail -n 70 "$MBBS_TEST_ARTIFACT_DIR/migrate.log";exit 1;fi
echo 'Disposable database migrations applied.'
if (( $# == 0 )); then set -- node tools/repair-gauntlet.mjs;fi
"${compose[@]}" run --rm --no-deps -T e2e "$@"
