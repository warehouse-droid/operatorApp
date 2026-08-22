#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

required_files=(
  "${server_root}/migrations/175_mbt_mbbs_cross_charge_route_pricing_v4.sql"
  "${server_root}/test/mbt/specs/mbbs-cross-charge-route-pricing-v4.md"
  "${server_root}/test/mbt/unit/mbbs-cross-charge-route-pricing-v4.red.test.js"
  "${server_root}/test/mbt/property/mbbs-cross-charge-route-pricing-v4.property.test.js"
  "${server_root}/test/mbt/integration/mbbs-billing-candidates.test.js"
  "${server_root}/test/mbt/integration/mbbs-cross-charge-route-pricing-v4-migration.test.js"
  "${server_root}/test/support/run-mbbs-cross-charge-v4-mutations.mjs"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -f "${required_file}" ]]; then
    echo "Missing MBBS cross-charge v4 evidence file: ${required_file}" >&2
    exit 1
  fi
done

rg -q "base_amount_minor" "${server_root}/migrations/175_mbt_mbbs_cross_charge_route_pricing_v4.sql"
rg -q "included_metres" "${server_root}/migrations/175_mbt_mbbs_cross_charge_route_pricing_v4.sql"
rg -q "origin_address_text" "${server_root}/migrations/175_mbt_mbbs_cross_charge_route_pricing_v4.sql"
rg -q "to_replenishment_multi_drop" "${server_root}/src/mbt/mbbs-driver-billing-planner.js"
rg -q "longest_origin_to_drop" "${server_root}/src/mbt/mbbs-billing-candidate-service.js"
rg -q "dispatch_delivery_address" "${server_root}/src/mbt/mbbs-billing-candidate-service.js"
rg -q "destinationAddressOverride" "${server_root}/src/mbt/mbbs-driver-billing-planner.js"
rg -q "mbbsBillingOriginText" "${server_root}/public/mbt-billing.html"
rg -q "mbbsBillingDestinationText" "${server_root}/public/mbt-billing.html"

if rg -n "TODO|FIXME|temporary bypass|skip validation" "${required_files[@]}"; then
  echo "MBBS cross-charge v4 evidence contains an unfinished marker." >&2
  exit 1
fi

echo "MBBS cross-charge v4 source-state checks passed."
