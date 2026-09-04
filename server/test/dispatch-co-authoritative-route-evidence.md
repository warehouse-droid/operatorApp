# Dispatch CO authoritative-route repair evidence

Date: 2026-09-01 UTC
Production witness: `SOA07894` / `GOA-7894-7895` / `CO-GOA-7894-7895`

## Diagnosis

- The 20:14 UTC audit sequence received and saved the original CO as
  `2967 -> 3445`; the first HTTP request therefore did carry `3445`.
- Later writes at 21:10 and 21:16 UTC correctly saved `2967 -> 12441`.
- `local_co_orders`, `dispatch_global_order_groups`, and
  `dispatch_order_catalog_entries` all held the corrected route during
  diagnosis.
- Repeated plan commands were rejected with `STALE_DISPATCH_PLAN` and a
  snapshot-digest mismatch. Plan 265 revision 96 still contained the older
  planner representation.
- `preserveDispatchPlanningFields` treated only `transitCo: null` as
  authoritative. A targeted feed containing a current active CO was therefore
  overwritten by the stale non-null CO already in browser/planner memory.
- After the first browser-merge repair, the user confirmed that the standalone
  CO card was still stale on different computers. Plan 265 revision 97 held a
  shared standalone `CO-GOA-7894-7895` snapshot at `2967 -> 3445`, even though
  its grouped source order and the live CO row both said `2967 -> 12441`.
- Bootstrap reconciliation queried live COs referenced by source orders, but
  omitted the standalone card's own CO ref when its legacy child details made
  it look like an aggregate CO group. Consequently every computer received the
  same stale standalone snapshot.

## RED and GREEN evidence

- With the old merge implementation, the isolated DP-03b witness failed:
  expected `toYard = 12441`, actual `toYard = 3445` (30 pass, 1 fail).
- With the repair, the focused deterministic and property suite passes 32/32.
  The property test runs 250 generated combinations of configured yards,
  lifecycle states, and group-child lists.
- The related CO/catalog/snapshot/stale-command and asset-version regression
  suite passes 20/20 in a disposable database.
- Reversed test order with concurrency 2 passes 32/32.
- JavaScript syntax, legacy syntax, ESLint, scoped TypeScript, dependency
  listing, secret scan, and source-state checks pass.
- The follow-up backend witness failed against the pre-repair source with
  expected `destinationYard = 12441`, actual `destinationYard = 3445`.
- After adding direct standalone-CO reconciliation, the final focused suite
  passes 34/34, the related Dispatch lifecycle/concurrency suite passes 21/21,
  and reversed order with concurrency 2 passes 34/34. The backend property
  test checks 250 generated active routes and proves immutability and
  idempotence while preserving children and unrelated plan evidence.

## Mutation evidence

The isolated manual mutation runner killed 3/3 mutants:

1. Reintroducing the original active-CO precedence bug.
2. Dropping preservation of `transitOriginalSourceYard` on sparse feeds.
3. Treating a sparse feed that omits `transitCo` as authoritative.

The property test alone kills the original-bug mutant (1/1). The runner hashes
and restores its disposable source copy, then reruns the green baseline.

The follow-up backend mutation runner also killed 3/3 mutants:

1. Letting the stale snapshot destination override the active CO row.
2. Omitting an aggregate-classified standalone CO from direct-row lookup.
3. Preserving the stale destination address after route repair.

Its property test alone kills both applicable route/address mutants (2/2).

## Repository-wide baseline comparison

Before the later cache-key test updates, the exact pre-repair image failed the
same seven files as the repaired image:

- pre-repair: 7 failures in 96 files;
- repaired: 7 failures in 97 files;
- delta: zero new failing files; the additional property file passed.

The failures were existing worktree failures in three asset-key contracts and
four unrelated Dispatch integration files. The three asset-key contracts now
pass in the related suite. A current repository-wide `typecheck:mbt` remains
red only for four implicit-any errors in
`run-scm-manual-split-authority-mutations.mjs`; the repair-specific scoped type
check passes. These unrelated baseline defects were not changed by this repair.

## Production rollout

- Derived image:
  `mbbs-operator-app:co-authoritative-route-20260901T213517Z`
- Exact base image:
  `mbbs-operator-app:to-dependency-plan-authority-scoped-20260901T213207Z`
  (`sha256:1f5eedaa80f0ab57688c93825e052feb4f476afac15fb7bb8593442ddc0c6250`)
- Scope: `/app/public/dispatch.js` and `/app/public/dispatch.html` only.
- The production web app alone was recreated; the database and webhook worker
  were not restarted or mutated.
- Post-deploy health is `healthy`; the local app response is HTTP 200; startup
  logs contain no error.
- Served hashes:
  - `dispatch.js`:
    `026d80930c4533aa1e82dacdd35584df8a219b5b4ba62ab9529c2987f114bf1a`
  - `dispatch.html`:
    `8f2057e7e185dc1f936038c561b6f06044a6b5a755ca03002b5d2a222d719a0d`
- The deployed asset key is
  `20260901-to-dependency-plan-authority-co-route-v2`.
- Post-deploy database verification reports
  `CO-GOA-7894-7895`, `2967 -> 12441`, `pending_load`, last updated
  `2026-09-01T21:16:21.237526Z`.
- The refreshed catalog projection reports source/pickup/CO destination
  `12441`, status `pending_load`, and children `SOA07894` and `SOA07895`.

### Shared-snapshot follow-up rollout

- Derived image:
  `mbbs-operator-app:co-snapshot-route-20260901T221849Z`
- Exact base image:
  `mbbs-operator-app:split-po-queued-20260901T215140Z`
  (`sha256:c9bcec6f5a5f6a4c340fcee5ac659884b80f13d4ee3f8fc4c0da31b7c98d05fb`)
- Scope: `/app/src/dispatch-co-lifecycle.js` only. The production app alone
  was recreated; the database and webhook worker were left running.
- Tested/live source hash:
  `67cae6b4ad1e21157ad3c8c15e0c3a3641b07d3e6960ec2b92ef089c1d758330`.
- The container is `healthy`, `/health` returns
  `{"ok":true,"app":"MBBS Yard Server"}`, and startup logs contain no error.
- The live plan-265 bootstrap at revision 97 now returns the shared standalone
  card as `2967 -> 12441`, destination location ID 15, the Woodbine address,
  source order `GOA-7894-7895`, and children `SOA07894` / `SOA07895`.
- No CO cancellation, recreation, or database rewrite was performed. Read and
  save reconciliation now use the active local CO row as route authority; the
  next ordinary plan save persists the reconciled representation.

### Cancelled-card and Ungroup follow-up rollout

- The user explicitly cancelled `CO-GOA-7894-7895`; the local row committed as
  `cancelled` at `2026-09-01T22:22:45.056Z`, and the optimized order catalog no
  longer returned the CO.
- Before the follow-up repair, live plan 265 revision 97 still returned the
  standalone CO card as visible and plannable. Its legacy child types made it
  look like a synthetic aggregate, so the direct cancelled row did not enter
  `invalidCoRefs` and the card survived reconciliation.
- The pre-fix executable witness failed with the cancelled CO still present.
  After the repair it removes the card and all stale load order/stop references
  while preserving unrelated orders, input immutability, and idempotence.
- Final isolated results: focused 35/35, related lifecycle/concurrency 21/21,
  and reversed-order concurrency 35/35. The backend mutation runner killed
  4/4 mutants, including the exact mutant that makes an aggregate-classified
  cancelled standalone CO plannable again; all route-specific mutants total
  7/7 killed across the frontend and backend runners.
- Derived image:
  `mbbs-operator-app:co-cancel-cleanup-20260901T222722Z`, from exact base
  `mbbs-operator-app:co-snapshot-route-20260901T221849Z`
  (`sha256:8dcc10a9d3f0011f8de587ee6221c590830bd08ec9589dfe1c847e582575ed90`).
- Scope remained `/app/src/dispatch-co-lifecycle.js` only. The app alone was
  recreated; the database and worker were not restarted.
- Tested/live source hash:
  `704919841be21426e94f730ecb41dccfee20f513f786f1ecf8051f37849c316d`.
- The app is healthy and `/health` returns
  `{"ok":true,"app":"MBBS Yard Server"}`. Live plan 265 now omits
  `CO-GOA-7894-7895` and returns `GOA-7894-7895` with `transitCo: null`, which
  releases the frontend Ungroup guard.
- A separate child-yard discrepancy remains for explicit operator mapping:
  the user reports one child at 2967 and one at 3445, while live NetSuite line
  locations, local `sales_orders`, and the pre-group audit currently report
  both `SOA07894` and `SOA07895` at 2967. No child yard was guessed or rewritten.

### Derived-order freshness and retirement follow-up

The later stale-state incident was not a browser-cache problem. Audit and
immutable history show that Ungroup succeeded on plan 265 revisions 98, 99,
and 100 around 22:35 UTC. Revision 100 contained neither the GOA nor the CO.
The same older browser session subsequently emitted `orders_grouped`,
reinitialized the CO as `2967 -> 12441`, dropped it, and then force-saved plan
revision 101 at 22:53:18 UTC. The old server accepted that full stale snapshot,
raising its order count from 76 to 78 and recreating shared records that every
computer then received.

The repair establishes these contracts:

- NetSuite source/catalog rows and active global definitions are authoritative
  for every live pool, plan, and bootstrap read.
- Historical plan snapshots remain immutable. NetSuite refresh never rewrites
  archived evidence; a plan save creates a new revision.
- Ungroup/Unsplit records an explicit, revisioned retirement. A delayed
  catalog refresh or stale force-save cannot reactivate a retired group,
  split, consolidation, or other derived definition.
- Only an explicit Group/Split action may reactivate a retired ref, and
  mixed-case reactivation reuses the canonical stored identity.
- Structural sync and retirement take the same per-reference advisory locks,
  so completion order cannot change the result.
- The browser keeps authoritative tombstones across feeds, assignments,
  history, saves, and cross-computer events. CO cancellation immediately
  clears cards, stops, routes, assignments, and stale evidence.

#### Exact 13-stage replay

The executable replay uses `SOA07894`, `SOA07895`, `GOA-7894-7895`,
`CO-GOA-7894-7895`, and `SOA07894-S1`. Each boundary asserts durable backend
state, catalog/pool visibility, current-plan bootstrap state, and the rendered
Chromium page.

| Stage | Trigger | Expected live result |
| ---: | --- | --- |
| 1 | NetSuite initial sync | SOA07894=2967; SOA07895=3445 |
| 2 | Group | GOA route=2967/3445 |
| 3 | NetSuite SOA07895 3445 -> 2967 | GOA route=2967; saved old revision remains unchanged |
| 4 | Initialize CO 2967 -> 12441 | GOA and CO render at 12441 |
| 5 | NetSuite SOA07894 2967 -> 150 while CO active | active CO stays 12441; recovery route becomes 150/2967 |
| 6 | Cancel CO | CO disappears; GOA restores 150/2967 |
| 7 | Reinitialize CO 150 -> 3445 | GOA and CO render at 3445 |
| 8 | Cancel, Ungroup, delayed stale group refresh/save | GOA absent; stale resurrection rejected |
| 9 | Split SOA07894 | SOA07894-S1 route=150 |
| 10 | NetSuite parent 150 -> 12441 | live split=12441; old saved split remains 150 |
| 11 | Unsplit, delayed stale split refresh/save | split absent; stale resurrection rejected |
| 12 | Explicit Regroup | GOA route=12441/2967 |
| 13 | Initialize final CO 12441 -> 150 | GOA and CO render at 150 |

#### High-assurance test evidence

- Full isolated source gauntlet: focused lifecycle/property/race suite 27/27;
  related group/split/catalog/CO/planner suite 44/44; reordered-concurrency
  suite 16/16.
- The property specification ran 1,000 generated route histories. Retirement
  races covered 40 catalog/deactivate interleavings plus 36 exported
  sync/deactivate interleavings across groups, splits, and consolidations.
- One real Chromium page consumed all 13 continuous events and passed 1/1.
- Manual mutation testing killed 8/8 injected bugs, including stale source
  precedence, inactive catalog-shadow recreation, incomplete retirement
  cleanup, and implicit stale-force-save reactivation.
- Syntax, legacy syntax, ESLint, scoped TypeScript, dependency, secret, diff,
  and source-state boundaries passed.
- The exact selective production candidate was tested again independently:
  focused 27/27, adjacent 44/44, and Chromium replay 1/1.

#### Production rollout and live verification

- Derived image:
  `mbbs-operator-app:derived-order-freshness-retirement-20260901T235610Z`
  (`sha256:f9f94b58c5fb2a19581300bfd108c11f24bf2b8062d987203e3132ac0fefa8bf`).
- Exact base:
  `mbbs-operator-app:co-cancel-cleanup-20260901T222722Z`
  (`sha256:f07b8e553b555fc9e785b2a3036f92dfc8d516d5bb06f06b48c3bb0cd3734ad6`).
- Overlay manifest:
  `sha256:8767bf89a9db10b3e86f27915e128ec4edefacaae230ba9cb9c739ec1c7a97d8`.
  It contains eight files only; unrelated completion work was excluded from
  mixed files. There is no migration, package, database, or worker change.
- The app alone was recreated at 00:08:11 UTC. It is healthy with zero
  restarts; `/health` returns `{"ok":true,"app":"MBBS Yard Server"}`.
  The database and webhook-worker container IDs and start times are unchanged.
- Post-deploy catalog revision 1504 has both source orders at 2967. Searching
  `CO-GOA-7894-7895` returns no card and its obsolete catalog shadow is gone.
  Plan 265's live bootstrap hides the obsolete CO card and stops.
- `GOA-7894-7895` remains visible for a valid operational reason: it is still
  actively assigned on confirmed plan 266, BC71838 Load 1. The active local CO
  remains assigned on confirmed plan 265, BC71838 Load 5. Completing the user's
  requested cleanup therefore requires explicit removal from those two
  confirmed loads before normal CO cancellation and Ungroup; stored confirmed
  plan JSON was not edited directly.

## Reproduction

Run from the repository root:

```bash
bash server/tools/dispatch-co-authoritative-route-gauntlet.sh
bash server/tools/dispatch-derived-order-freshness-gauntlet.sh
```

The gauntlet uses a distinct Compose project and disposable database and
refuses the production Compose project.
