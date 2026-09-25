#!/usr/bin/env bash
set -Eeuo pipefail
entries=(contracts/sor-browser.d.ts src/sor-rental-policy.js src/sor-rental-repository.js src/sor-rental-service.js src/sor-rental-routes.js src/sor-signature-evidence.js src/sor-return-readiness.js public/sor-admin.js public/sor-signature.js public/sor-driver-signature.js)
if [[ "${1:-current}" == baseline ]]; then entries=(src/netsuite.js src/dispatch-fleet-status.js src/db.js); fi
exec node_modules/.bin/tsc --ignoreConfig --noEmit --allowJs --checkJs --strict false --skipLibCheck --target ES2022 --lib ES2022,DOM --module NodeNext --moduleResolution NodeNext --moduleDetection force "${entries[@]}"
