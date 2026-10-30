#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0"
fi
test_name="mbbs-ifir-quantity-image-$$"
cleanup() {
  result=$?
  trap - EXIT INT TERM
  docker rm -fv "$test_name" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  [[ -z "$(docker ps -aq --filter "name=^/$test_name$")" ]] || result=1
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
python3 -B - "$test_name" <<'PY'
import importlib.util,json,os,pathlib,sys
spec=importlib.util.spec_from_file_location('release',pathlib.Path(os.environ.get('IFIR_RELEASE_TOOL_PATH','server/tools/ifir-quantity-release.py')))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
data=r.core.state();r.current(data)
actual=json.loads(r.core.bounded(data['candidateImageId'],sys.argv[1],'node','-e',r.core.HASH_SCRIPT))
assert actual==data['candidateTree']
script="await import('./src/server.js');console.log(JSON.stringify({serverImport:true}));process.exit(0)"
output=r.core.bounded(data['candidateImageId'],sys.argv[1],'node','--input-type=module','-e',script)
assert b'"serverImport":true' in output
(pathlib.Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'import.log').write_bytes(output)
record={'passed':True,'at':r.core.now(),'imageId':data['candidateImageId'],
        'runtimeFilesVerified':len(actual),'candidateTreeHash':data['candidateTreeHash'],'serverImport':True}
r.core.save('image-check.json',record);print(json.dumps(record))
PY
