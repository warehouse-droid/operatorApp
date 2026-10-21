# Split dialog latency specification

Spec approval: not obtained (autonomous run). Read-only performance change; existing resplit mutation and its fleet/operator/lease guards remain unchanged.

The existing Split dialog appears before its status request resolves and disables confirmation while waiting. It uses an exact selected-order preview instead of the full search feed, preserving fresh packing/loading checks and current item quantities. Read only the selected SO/TO header/lines and exact persistent split definition; no global history, billing-family scans, search enrichment, NetSuite calls or mutations. Native split progress overrides the parent's progress. Unmaterialized registered splits use the parent status and their own retained items. TO receiving lines do not imply outbound packing. Retired, missing, inactive and ambiguous identities fail closed. Loaded CO evidence still blocks source splitting.

Late responses after closing/reopening, changing selection or changing date cannot reopen the dialog or override a newer check. Failure shows an error and keeps confirmation disabled. Existing split action count, first-level splitting, S2->S3/S4/S5, completed S1 history, quantity conservation, packed/loaded restrictions, auth and immutable records remain intact.

Failure model: expensive broad reads -> exact indexed queries plus selected-order benchmark; stale packing -> fresh native line/status examples; premature/late confirmation -> deferred browser requests and stale-response tests; quantity scope -> split/native item mapping and previous resplit suite; unauthorized data -> real HTTP auth/cache tests; accidental writes -> real READ ONLY transaction and unchanged snapshots.

Setup: captured live source overlays, existing bounded disposable Compose tooling, Node/PostgreSQL/Playwright/c8/TypeScript/ESLint/fast-check. No dependencies, migrations or commits. Register teardown before creating containers, remove volumes/networks/containers and verify both Docker listings. Preserve logs and code; release only verified overlays with rollback. Production checks are read-only.
