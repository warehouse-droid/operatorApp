# Sales Order partial re-attempt verification evidence

- Verification date: 2026-08-14 UTC
- Specification approval: autonomous from the user's explicit nine-point design and SOM05681 evidence
- Final feature source state: `69ed93882ca8d22a75b3f41b4a101ea827a0635b54a573cfed799ff11a65e557`
- Environment: isolated Docker Compose projects using `docker-compose.mbt-test.yml`; no production writes

## Executable specification

The acceptance and invariant catalog is in `test/sales-order-reattempt-spec.md`. The first focused run was RED because the preview policy, migration, HTTP endpoint, planner projection, and Control UI did not yet exist. The final focused suite contains ten passing tests.

## Final feature gauntlet

Command:

```text
bash server/tools/sales-order-reattempt-gauntlet.sh
```

Result: PASS from 2026-08-14T20:40:27Z through 2026-08-14T20:41:08Z. The complete log is `test-artifacts/sales-order-reattempt/latest.log`.

The source-bound gauntlet proved:

- clean application of migrations 001 through 164;
- 10/10 focused policy, property, UI-contract, and database integration tests;
- 6,480 legacy reload quantity properties;
- 20 reload integration scenarios;
- 35 delivery projection scenarios;
- 25 yard-history scenarios;
- 49 UI assertions;
- 5 photo-entry tests;
- 14 idempotency scenarios;
- 15/15 killed reload/re-attempt mutants;
- 97.39% statements and lines, 100% functions, and 86.69% branches for `sales-order-reload.js`;
- public, server, reload-repository, delivery-repository, custom-order-repository, and billing-candidate syntax.

## Whole-repository and static gates

Final commands and results against the same final source:

```text
npm run test:mbt
PASS: 307/307 isolated files, 1,638 tests

npm run typecheck:mbt
PASS

npm run lint:mbt
PASS, zero warnings
```

The first whole-repository pass exposed only two stale migration-163 inventory assertions. Both were updated for migration 164, passed individually, and the complete 307-file suite was then rerun successfully on the final source.

## Critical invariant evidence

The SOM05681-shaped database integration test proves that:

- only the selected historical 16-pallet line enters the re-attempt while the 3-pallet line remains delivered evidence;
- historical `HISTORICAL-CG` and current `CURRENT-GN` identities are both visible;
- one atomic cycle/child pair is created and exact request replay is idempotent;
- the child retains 16 pallets, calculated weight, pickup yard, destination, and parent linkage;
- the child is hidden from Operator and direct Operator APIs until Dispatch plans it;
- the planned child inherits its actual date, truck, and load;
- completion of the child cannot create an independent MBBS billing candidate;
- the original Sales Order, lines, grouped stop, Driver completion, and inventory balances are byte-for-byte unchanged.

No deployment was performed.

## Test teardown

The `mbbs-sales-order-reattempt-gauntlet`, `mbbs-sales-order-reattempt-full`, `mbbs-sales-order-reattempt-coverage`, and `mbbs-sales-reattempt-red` Compose projects were removed with their isolated networks and volumes. The exact unused `mbbs-mbt-p1-test-test:latest` image (`sha256:0beaf82fe6b1c25e60de0b84b15cfb8bafc30e6e81acd0c0eb205e1e0a2d8f83`) was deleted. Verification showed only the three healthy `mbbs-operator-app` production containers remained.
