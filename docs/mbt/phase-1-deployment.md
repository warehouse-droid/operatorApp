# Phase 1 Deployment Gate

Phase 1 adds foundation schema and controlled, disabled surfaces. It does not
authorize MBT operations. Use this sequence so the new foundation cannot alter
today's Dispatch, Driver, Smart SCM, Billing, or NetSuite behavior.

## Required order

1. Build the release image without replacing the running application.
2. Confirm `MBT_ENABLED=false` and `MBT_NETSUITE_WRITES_ENABLED=false` in the
   release environment. Do not enable any `mbt_feature_flags` row.
3. Use a brief maintenance window, or bounded lock monitoring with
   abort-and-retry, while applying migrations 102–107. Migration 102 replaces
   constraints on `operators`; migration 104 adds fail-closed fields and a
   constraint to `dispatch_trucks`.
4. Before starting the new image, run its read-only preflight with
   `MBT_PREDEPLOY_READ_ONLY=1` and the normal database connection:

   ```text
   npm run preflight:mbt-p1-deploy
   ```

5. Continue only when the JSON result has `ready: true`, no missing migrations,
   no enabled flags, and no Dispatch collisions.
6. Start the application, verify `/health`, and smoke the established Admin,
   Operator, Dispatch, SCM, Yard Manager, Sales, and Driver routes. The MBT
   Front Desk and Billing pages must still say they are not operational.

## Stop conditions

- If `dispatchCollisions` is non-empty, do not deploy the new application
  image. The listed current/history snapshot already uses the reserved BIN
  identity and must be reviewed without deleting driver or dispatch evidence.
- If a migration waits beyond the deployment lock budget, abort and retry in a
  maintenance window. Do not start new code against schema 101.
- If any MBT flag is enabled, disable it through an audited database change and
  rerun the preflight. Phase 1 never requires an operational flag.

The preflight is read-only. Its output contains snapshot/plan identifiers and
reserved identity IDs/types, not full orders, customer data, or credentials.
