#!/usr/bin/env bash
set -euo pipefail
r2_repo=$(cd "$(dirname "$0")/../.." && pwd)
r2_artifacts="$r2_repo/server/test-artifacts/driver-reconnect-20261016/r2"
r2_tickets=$(mktemp -d /tmp/mbbs-reconnect-tickets.XXXXXX)
r2_container="mbbs-reconnect-r2-$$"
r2_cleanup_mode=${R2_CLEANUP_MODE:-verify}
if test "$r2_cleanup_mode" != cleanup && test "$r2_cleanup_mode" != verify; then exit 2; fi
mkdir -p "$r2_artifacts"
r2_run=(docker run --rm --pull=never --name "$r2_container" --label com.mbbs.lifecycle=disposable-test
  --cgroup-parent=mbbs-tests.slice --init --memory=1536m --memory-swap=1536m --cpus=1 --pids-limit=256
  --read-only --network=bridge --tmpfs /tmp:rw,nosuid,nodev,size=256m
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright --workdir /app
  --env "R2_ENGINE=${R2_ENGINE:-}"
  --env SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
  --mount type=bind,source=/etc/ssl/certs/ca-certificates.crt,target=/etc/ssl/certs/ca-certificates.crt,readonly
  --mount "type=bind,source=$r2_repo/server/public,target=/public,readonly"
  --mount "type=bind,source=$r2_repo/server/tools/driver-reconnect-r2.mjs,target=/app/replay.mjs,readonly"
  --mount "type=bind,source=$r2_repo/server/test-artifacts/driver-upload-reliability/toolchain/node_modules,target=/app/node_modules,readonly"
  --mount "type=bind,source=$r2_artifacts,target=/evidence"
  --mount "type=bind,source=$r2_tickets,target=/tickets,readonly"
  --entrypoint node mbbs-to-yard-test-browser:20261009 /app/replay.mjs)
cleanup_r2() {
  r2_status=$?
  docker rm -f "$r2_container" >/dev/null 2>&1 || true
  if test -s "$r2_artifacts/objects.json"; then
    docker exec -i mbbs-operator-app-app-1 node --input-type=module -e '
      import {createPhotoReadToken,createPhotoDeleteToken} from "./src/photo-upload.js";
      let raw=""; for await (const chunk of process.stdin) raw+=chunk;
      const objects=JSON.parse(raw); const actor={role:"system",id:"photo-archive"};
      const result=objects.map(({key})=>{
        if (!/^driver-reconnect-test\/test-upload\//.test(key)) throw new Error("Refusing non-test cleanup key");
        return {key,read:createPhotoReadToken({actor,key}),...(process.argv[1]==="cleanup" ? {remove:createPhotoDeleteToken({actor,key})} : {})};
      }); process.stdout.write(JSON.stringify(result));
    ' "$r2_cleanup_mode" < "$r2_artifacts/objects.json" > "$r2_tickets/objects.json" &&
      "${r2_run[@]}" "$r2_cleanup_mode" > "$r2_artifacts/cleanup.log" 2>&1 || r2_status=1
  fi
  rm -rf "$r2_tickets"
  docker rm -f "$r2_container" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$r2_artifacts/docker-ps.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$r2_artifacts/docker-ps-a.txt"
  docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$r2_artifacts/production-health.txt"
  exit "$r2_status"
}
trap cleanup_r2 EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if test "${1:-replay}" = cleanup; then exit 0; fi
docker exec -i mbbs-operator-app-app-1 node --input-type=module > "$r2_tickets/upload.json" <<'JS'
import {createPhotoUploadToken} from './src/photo-upload.js';
import {randomUUID} from 'node:crypto';
const tickets=[];
for (let browser=0;browser<2;browser++) {
  const photoId=`reconnect-${randomUUID()}`;
  for(let attempt=0;attempt<3;attempt++) tickets.push(createPhotoUploadToken({actor:{role:'system',id:'driver-reconnect-test'},source:'driver-reconnect-test',recordType:'test-upload',metadata:{photoId},options:{ttlMinutes:15,maxBytes:2097152,allowedTypes:['image/jpeg']}}));
}
process.stdout.write(JSON.stringify(tickets));
JS
"${r2_run[@]}" replay 2>&1 | tee "$r2_artifacts/replay.log"
