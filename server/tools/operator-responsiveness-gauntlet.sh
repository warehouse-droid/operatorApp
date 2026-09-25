#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
export SOR_CANDIDATE_ROOT="${SOR_CANDIDATE_ROOT:-/home/ubuntu/operatorapp-deploy-backups/operator-responsiveness-20260924-v1/candidate}"
if ! sudo -n docker inspect mbbs-sor-rentals-test-db >/dev/null 2>&1; then sudo -n bash tools/sor-rentals-test-env.sh start; fi
if [[ ! -f test-artifacts/sor-rentals/all-orders-snapshot.json ]]; then python3 tools/sor-all-orders-capture.py; fi
sudo -n env SOR_CANDIDATE_ROOT="$SOR_CANDIDATE_ROOT" bash tools/sor-rentals-test-env.sh run candidate node src/migrate.js
if [[ "$(sudo -n docker exec mbbs-sor-rentals-test-db psql -U mbt_test -d mbt_test -X -At -c "SELECT count(*) FROM pg_database WHERE datname='mbt_test_quality'")" == 0 ]]; then
 sudo -n docker exec mbbs-sor-rentals-test-db createdb -U mbt_test mbt_test_quality
fi
sudo -n env SOR_CANDIDATE_ROOT="$SOR_CANDIDATE_ROOT" SOR_TEST_DATABASE=mbt_test_quality bash tools/sor-rentals-test-env.sh run candidate node src/migrate.js
python3 tools/operator-responsiveness-checks.py tests
python3 tools/operator-responsiveness-checks.py static
python3 tools/operator-responsiveness-checks.py mutations
python3 tools/operator-responsiveness-checks.py coverage
sudo -n env SOR_CANDIDATE_ROOT="$SOR_CANDIDATE_ROOT" bash tools/sor-rentals-test-env.sh run candidate node tools/sor-all-orders-replay.mjs
sudo -n docker exec mbbs-sor-rentals-test-db dropdb --if-exists -U mbt_test mbt_test_driver
sudo -n docker exec mbbs-sor-rentals-test-db createdb -U mbt_test -T mbt_test mbt_test_driver
sudo -n env SOR_CANDIDATE_ROOT="$SOR_CANDIDATE_ROOT" SOR_TEST_DATABASE=mbt_test_driver bash tools/sor-rentals-test-env.sh run candidate node tools/sor-all-orders-driver.mjs
sudo -n env SOR_CANDIDATE_ROOT="$SOR_CANDIDATE_ROOT" SOR_TEST_DATABASE=mbt_test_driver bash tools/sor-rentals-test-env.sh run candidate node tools/sor-completed-returns-replay.mjs
python3 tools/operator-responsiveness-checks.py report
