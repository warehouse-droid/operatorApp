#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose=(docker compose -f "${repo_root}/docker-compose.mbt-test.yml" --profile tools)

cd "${repo_root}"
"${compose[@]}" build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" run --rm migrate
"${compose[@]}" run --rm test npm run test:google-maps-usage
"${compose[@]}" run --rm test npm run coverage:google-maps-usage
"${compose[@]}" run --rm test npm run lint:google-maps-usage
"${compose[@]}" run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:google-maps-usage
"${compose[@]}" run --rm test npm run secrets:google-maps-usage
docker run --rm --read-only \
  --volume "${repo_root}:/workspace:ro" \
  --workdir /workspace \
  mbbs-mbt-p1-test-test:latest \
  node /app/test/support/scan-diff-secrets.mjs docker/v2.env.example

echo "Google Maps usage-control gauntlet complete. Production replay is a separate read-only operation."
