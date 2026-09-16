# Dispatch split target — evidence

## Result

Fixed and applied to the running app on September 15, 2026. Hovering an order
no longer assigns its ID to `selectedOrderId`. Selecting SOA08748 and hovering
SOA08716 now keeps the Split action on SOA08748, while the tooltip still shows
SOA08716. The HTML script version was updated so a page refresh loads the fix.

The user had already completed the intended split by refreshing and reselecting.
No live plan, dependency, quantity, or order record was changed by this fix.
Only `public/dispatch.js` and `public/dispatch.html` were updated in the running
container, with no app restart. Their served HTTP contents match the tested
SHA-256 hashes; `/dispatch/planning` and `/health` both returned 200.

## Diagnosis

The saved order was valid. Recovery drafts contained unintended SOA08716-S1/S2
and an `order_split` audit targeting SOA08716. The initial interpretation that
the user had attempted that split was corrected after their clarification.
No implementation of the initially proposed dependency guard was made.

The concrete defect was in `showOrderTooltip`: pointer hover silently changed
the primary selection, while the multi-selection set remained unchanged. A
later refresh rendered action buttons for the hovered order. The corrected
tests reproduced this before the fix, including the wrong Split button target.

Spec: [dispatch-split-target-spec.md](dispatch-split-target-spec.md), corrected
scope section. Spec approval: not obtained (autonomous run); the user explicitly
confirmed the intended target and requested the concrete hover bug be fixed.

## Final verification

| Check | Result |
| --- | --- |
| Before-fix regression run | 5/5 tests failed on selection/target assertions |
| Focused tests | 5/5 passed, including 75 seeded hover-sequence property cases |
| Complete Dispatch frontend suite | 235/235 passed; original baseline 230/230 passed |
| Chromium workflow | 1/1 passed; zero page errors |
| Existing harnesses | Physical-visit tooltip, save coordination, and yard dependency structure passed; the dependency harness reports 17 assertions |
| Deliberate mutations | 3/3 caught: change primary selection, replace multi-selection, clear primary selection |
| Static checks | JavaScript syntax, scoped tooltip lint, and test/tool lint passed; zero lint warnings |
| Diff and secret checks | `git diff --check` passed; task diff and 8 new paths scanned without high-confidence findings |
| Runtime coverage | The affected tooltip function executed 412 times in the final focused run; the code change removes one statement and adds no executable lines |
| Live verification | Served JS/HTML hashes match the tested files; planner and health return 200 |

The Chromium test runs the complete production `dispatch.js` with fixture API
responses: click SOA08748 → hover SOA08716 → refresh controls → open Split →
confirm → inspect the submitted save and audit. The save contains
SOA08748-S1/S2 plus unchanged SOA08716, and the split audit names SOA08748.
It also checks that clicking SOA08717 still changes selection normally.

Machine-readable results: [checks.json](../test-artifacts/split-target/checks.json),
[browser-result.json](../test-artifacts/split-target/browser-result.json),
[mutations.json](../test-artifacts/split-target/mutations.json).
Screenshot: [browser.png](../test-artifacts/split-target/browser.png).

## Limits and reproducibility

No database/server code, dependencies, API signatures, or concurrency mechanism
changed. Full backend/MBT suites, database stress tests, and supply-chain audits
were not applicable to this removal of browser selection mutation. The optional
PO multi-drop harness passed its tooltip assertions, then failed with
`ECONNREFUSED` at its database setup; its database portion was excluded explicitly
from this network-isolated browser suite. Browser JavaScript is outside the
project TypeScript configuration, so no type-check claim is made. Mutation kills
are attributed to the focused suite as a whole. The frontend and focused tests
were repeated; file-order randomization was not run. These checks verify the
specified hover/split behavior rather than every possible production state.

Run from the repository root:

```bash
bash server/tools/dispatch-split-target-gauntlet.sh
```

Existing images used: `mbbs-retired-confirm-test:20260914` and
`mbbs-mbt-p1-test-e2e:latest`. Tools: Node 20.20.2, fast-check 4.9.0, ESLint
10.8.0, c8 12.0.0, Playwright 1.62.1. Tests have no live database or network
access. The browser uses a loopback fixture HTTP server inside its container.

The workspace already contained other changes. Task-specific before/after diff:
[task.patch](../test-artifacts/split-target/task.patch). Tested source hashes are
in `checks.json`; no commits, resets, or unrelated source edits were made.
Live backups, staged files, hashes and installation results are in
`/home/ubuntu/operatorapp-deploy-backups/split-target-20260915`.
