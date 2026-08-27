# Smart SCM Blanket split inventory and PO completion evidence

Date: 2026-08-26 UTC

Status: passed and deployed 2026-08-26 14:47 UTC; no production data mutated

## Production evidence (read only)

- `POB03669` is the Blanket source for active split child `SN1399039`.
- The relevant item is `1158`: child quantity 198 sales units, 0 received,
  active/open, and 9 sales units per pallet.
- Both source and child resolve to location id 1 (yard 3445). Therefore the
  child is a legitimate same-yard Blanket release of exactly 22 PLT.
- NetSuite authoritative on-order at 3445 was 495 sales units and Blanket
  source exclusion was 594 sales units during the investigation.
- `SN1399039` currently has no canonical final completion row, so it should
  remain pending until its Driver drop-off is completed.

Expected calculation:

```text
max(0, authoritative 495 - Blanket exclusion 594)
  + released child inbound 198
= 198 sales units
/ 9 sales units per pallet
= 22 PLT
```

## Root cause and correction

The split overlay rejected rows when the source and destination yard were the
same. This silently discarded `SN1399039`. Adding the child to authoritative
on-order before subtracting the Blanket source would still have produced the
wrong result (11 PLT), because part of the released child would be swallowed
by the exclusion.

The corrected model separates:

1. authoritative deltas for ordinary PO split relocation; and
2. protected released-Blanket-child inbound, added after Blanket exclusion.

The same calculation is now used by phased planning, live proposal editing,
vendor alternatives, and the actual Blanket-plan builder.

PO Split completion presentation now overlays only exact, case-insensitive
canonical PO-reference completion evidence. A completed split remains visible
and displays `Completed`; a source PO, sibling, grouped peer, or pickup-only
Driver record cannot mark it complete.

## RED to GREEN proof

Before the correction, the focused executable contract failed because:

- the same-yard Blanket child produced no protected inbound delta;
- the frontend rendered `Planned` for canonical completed evidence; and
- the repository omitted a completed split row.

After the correction:

- focused unit, frontend, and PostgreSQL integration suite: 54/54 passed;
- actual `buildSmartScmBlanketPlan` persistence assertion passed with
  authoritative 90, Blanket exclusion 120, released child 50, effective
  on-order 50, and expected/proposed quantity 5 PLT;
- coverage gate passed: 99.67% statements/lines, 100% functions, and 91.94%
  branches across included files; `smart-scm-phased-planning.js` has 100%
  statements/lines/functions and 88.63% branches;
- mutation gate passed: 14/14 mutants killed (100%), including same-yard
  child deletion and released-child/exclusion ordering faults;
- focused and touched-file lint passed;
- legacy public-script syntax check passed;
- MBT TypeScript check passed;
- diff secret scan passed with no findings;
- scoped `git diff --check` passed.

## Isolation and cleanup

Tests ran in the disposable Compose project
`mbbs-blanket-split-completion-test`.

- Test containers, network, and volumes: removed and verified absent
- Test images `mbbs-mbt-p1-test-test:latest` and
  `mbbs-mbt-p1-test-mutation:latest`: removed and verified absent

## Production deployment

- Candidate/running image:
  `sha256:947b74fe72152b4da90d83a036a9ce3bd730a5f3822a7192260b98bdf3309f47`
- Previous image retained as:
  `mbbs-operator-app-app:rollback-20260826-blanket-split`
- Validated backup:
  `docker/backups/mbbs-before-blanket-split-20260826-144401.dump`
  (244,104,118 bytes; SHA-256
  `0bbe6b163d152c24e549906cae2efd620fdf3d83d86f610d507ab975250f0a69`)
- App-only cutover: 1.87 seconds. PostgreSQL and Ollama were not restarted;
  migration 181 was already applied.
- All three services reported healthy; `/health` returned HTTP 200; the served
  SCM page contained cache marker `20260826-blanket-split-completion-v2`.
- The running production container reproduced 198 effective units / 22 PLT.
- The initial startup CPU spike subsided while health remained green and logs
  remained error-free.

No production write, receiving update, split mutation, or Driver event was
performed as part of verification or deployment.
