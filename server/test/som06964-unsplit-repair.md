# SOM06964 operational repair, 2026-10-15

Completed before the general code fixes, as the user requested. Audit identity:
the previously user-selected `testAdmin` account.

All five PO allocations (268–272) to POB04024 / #263967 and POB04022 / #263968
were cancelled through the normal guarded dependency command service, with one
durable request receipt per allocation. No TO dependencies existed. Canonical
sales headers and lines were verified unchanged by the unlink operation.

The normal Unsplit command initially rejected the family with
`DISPATCH_SPLIT_QUANTITY_INVALID`: the first split held all sales quantities of
four non-inventory lines but had lost their descriptive piece counts. The original
parent still had all quantities. Both children were unplanned and unstarted, with
no packing, fulfillment or Driver work.

In one atomic audited transaction, the four exact child descriptive counts were
reconstructed from the full source lines (22, 5, 9, 12 pieces). This was permitted
only when one child held the entire source line and all conversion factors were
absent. The normal unsplit service then passed all lineage, execution, quantity
and locking guards and retired SOM06964-S1/S2. The original parent was verified
byte-for-byte unchanged, and its authoritative catalog entry was refreshed.

Fresh read-only checks confirm one locally open SOM06964 in Operator and Dispatch,
zero active PO allocations, zero TO dependencies and zero active splits. The
effective Dispatch plan hides both retired children. Raw cached plan rows may
remain until the existing edit-lease maintenance queue applies them; they are
excluded from the current plan response and cannot reactivate retired definitions.
NetSuite continues to show Billed. No NetSuite writes were made.

Reproducible read-only verification from the repository root:

```sh
sudo -n docker exec -i -w /app mbbs-operator-app-app-1 node --input-type=module \
  < server/tools/som06964-unsplit-20261015/verify.mjs
```

Before/after records, unlink receipts, the initial unsplit error, repair preflight,
committed repair result and fresh verification are retained in
`server/test-artifacts/som06964-unsplit-20261015`. The apply scripts are operational
records; they were never used as tests against production. No test resources were
created for this repair.
