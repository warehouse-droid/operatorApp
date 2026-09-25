#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$task_root/server/test-artifacts/operator-background-photos"
export BACKGROUND_PHOTO_SOURCE="${BACKGROUND_PHOTO_SOURCE:-$artifact/release/stage}"
modes=(suite-forward suite-reverse static coverage mutations)
# Resume infrastructure checks when both full-suite runs already passed for the
# same source hashes. Deployment independently checks those hashes again.
if [[ "${1:-}" == "remaining" ]]; then modes=(static coverage mutations); fi
for mode in "${modes[@]}"; do
  if [[ "$mode" == "static" ]]; then
    bash "$task_root/server/tools/operator-background-static.sh" static > "$artifact/final-static.log" 2>&1
  else
    bash "$task_root/server/tools/operator-background-test.sh" node tools/operator-background-checks.mjs "$mode" > "$artifact/final-$mode.log" 2>&1
  fi
done
bash "$task_root/server/tools/operator-background-browser-test.sh" > "$artifact/final-outbox.log" 2>&1
bash "$task_root/server/tools/operator-background-test.sh" node --test --test-concurrency=1 \
  test/mbt/integration/migration-upgrade.test.js test/mbt/integration/p3-predeploy-readiness.test.js \
  > "$artifact/final-migrations.log" 2>&1
BACKGROUND_PHOTO_MIGRATIONS_SOURCE="$BACKGROUND_PHOTO_SOURCE/migrations" \
  bash "$task_root/server/tools/operator-background-test.sh" node --test --test-concurrency=1 \
  test/mbt/integration/operator-background-photos.test.js test/mbt/integration/operator-background-http.test.js \
  > "$artifact/final-release-schema.log" 2>&1
LOCAL_LOAD_REPLAY_RUN=background-final-750kbps LOCAL_LOAD_REPLAY_UPLOAD_KBPS=750 \
  LOCAL_LOAD_REPLAY_SOURCE="$BACKGROUND_PHOTO_SOURCE" LOCAL_LOAD_REPLAY_SCRIPT=tools/operator-background-replay.mjs \
  bash "$task_root/server/tools/local-load-replay-test.sh" > "$artifact/final-replay.log" 2>&1
printf 'Background photo verification complete.\n'
