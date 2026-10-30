# PO to TO handoff evidence — 2026-10-22

Deployed on 2026-10-22 at 20:42 UTC, together with the SOA10414 split-status fix
and Delivery-to-Pickup automatic packing release. The user explicitly authorized
this combined deployment after the original approval-review rejection.
The exact combined runtime passed 125/125 regression tests; all 1,446 runtime
files, live SCM assets, application health, and the pickup rule were verified.
See [combined deployment evidence](scm-cargo-pickup-20261022-evidence.md).

Policy confirmed in chat: PO quantities cover demand after Order Request.
Unrequested quantities remain unmet demand for TO planning. Detailed spec
approval was not separately obtained (autonomous run); see
`smart-scm-po-to-handoff-spec.md`.

Reproduce from the repository root:

```sh
bash server/tools/scm-po-to-handoff-run.sh
```

Final complete run: Node v20.20.2, existing locked dependencies, no additions.

| Check | Result |
| --- | --- |
| Affected SCM suite | 123 tests: 122 pass, 1 confirmed baseline failure, 0 new failures |
| New policy coverage | 98/98 lines/statements, 5/5 functions, 30/30 branches |
| New randomized properties | 600 seeded cases, seeds 39131 and 39132 |
| Deliberate faulty implementations | 6/6 killed by unit/property tests; 6/6 also killed by properties alone |
| Scoped lint and strict policy-module types | Pass, zero warnings/errors |
| Repository/client syntax | Pass |
| Secret scan | Pass, 10 paths checked |
| Built release | All 1,445 runtime source files match the expected tree |
| Cleanup | Test containers, disposable storage/networks, temporary output removed; both Docker listings contain only the four production containers; app healthy |

Acceptance mapping:

| Spec | Executable evidence |
| --- | --- |
| 1–2: no request / partial / full request | Integration tests preserve 8, reduce 8 to 5, and reduce 8 to 0 respectively |
| 3: consistent priority and Stocking Purchase handling | Integration tests cover requested/unrequested replenishment and Purchase loads, and requests from earlier runs |
| 4–5: real orders, terminal rows, staged quantities | Real-inbound, cancelled/superseded, and vendor-review integration cases; invalid/missing/Blanket/non-PO unit cases |
| 6: conservation and unchanged physical stock | Blanket clamp and immutability unit cases; both randomized properties |
| 7: freeze, idempotency, rollback, concurrency | Repeated approval, injected transaction failure, and simultaneous PostgreSQL approvals |
| 8: existing behavior | Inbound/split, priority purchasing, manual-TO, skip-yard and Blanket regressions; source stock 24 below floor 35 still supplies zero |
| 9: user explanation | Three executed UI rendering tests plus existing calculation/vendor UI harnesses |

The unchanged baseline HTML also fails
`src/smart-scm-blanket-ui-harness.js`: it expects the obsolete
`scm-smart-exclusions.js?v=20260801-po-only-pauses-v1` asset. The baseline script
reproduces this exact failure. The final runner preserves that assertion and
rejects every additional failure.

Initial runs corrected fixture SQL type inference, an exception selector that
selected the source yard, and fixture complexity. The reported policy failures
were then observed as assertions (for example, requested 3 of 8 left 8 instead
of 5; an unrequested Purchase draft left 5 instead of 8). The final complete run
above followed those corrections.

Scope limits: the full unrelated repository gauntlet and browser engines were
not run. Existing integration fixtures retain their required deterministic
order. Coverage percentages apply to the new policy module; repository and UI
connections are exercised by workflow/rendering tests. Live NetSuite writes
were disabled in tests. No dependency audit was needed because dependencies
did not change. The runtime adds a database read, with no new network,
filesystem, or subprocess capability.

Prepared runtime source hashes:

```text
bca064f61726d6a1c966459958d010bb345cf0ae5ef6953d561a7c7dad528b73  src/smart-scm-po-handoff.js
380e26883c843cda9a297abdd0df53b75b6e7b76424e1b7b0ca41a81188090c7  src/smart-scm-planning-repository.js
9699f769b28706b04132cf512a4cd0d49e5ae016f7f1a8d6be47d207d880e9e0  public/scm-smart-proposals.js
66296ad1495facaed33d19fee98b9215e37f87c049e4b2954e471bcb8a41d9fe  public/scm-smart.html
```

Initially prepared image: `mbbs-operator-app:scm-po-to-handoff-20261022`.
The deployed image is `mbbs-operator-app:scm-cargo-pickup-20261022`; it preserves
the later dispatch update and production runtime configuration. The combined
release checked active operations before the app-only restart and retained the
previous image for rollback. Read-only deployment verification:

```sh
python3 server/tools/scm-cargo-pickup-release.py verify
```

At initial diagnosis, run 472 retained an 8-PLT shortage at yard 150 for item
1189. Yard 3445 had 24 PLT physically available against a 35-PLT protected
floor, so automatic transfer supply was zero. Manual load #39131 then contained
8 PLT with an explicit source-floor override. The final read observed that the
load had subsequently executed as TOB01261, with 4 PLT of BWS-PW-REG-GM and
three 1-PLT coping lines. This task made no live business-data edits. Approved
historical runs remain frozen.
