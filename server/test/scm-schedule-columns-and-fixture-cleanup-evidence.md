# Schedule columns and exact fixture cleanup — evidence

Spec: [scm-schedule-columns-and-fixture-cleanup-spec.md](scm-schedule-columns-and-fixture-cleanup-spec.md).
Spec approval: not obtained (autonomous run under the user's explicit removal and UI-change request).

## Delivered behavior

- ETA, Driver and SLA occupy one 170px column instead of three columns totaling 355px. Existing filters remain available in that header.
- The Columns chooser hides/restores all available data and utility columns. It retains at least one data column and supports keyboard controls, Show all and Reset layout.
- Choices persist by user and schedule surface in browser storage. Width/font/row preferences remain compatible. Visibility changes and resets preserve unsaved editors; targeted row saves preserve hidden columns.
- Only `scm-schedule.js`, `scm-schedule.html` and `dispatch.css` were deployed. Existing runtime configuration and the webhook worker image were verified unchanged.

## Database cleanup

`tools/remove-to-test-fixtures-0fb08978.sql` removed exactly the verified synthetic records:

| Record | Identity |
| --- | --- |
| Transfer fixture | `TOA-CO-DEPENDENCY-0FB08978`, 6526455537 |
| Transfer fixture | `TOA-GLOBAL-PICKUP-0FB08978`, 7000263227768 |
| Linked sales fixture | `SOA-CO-DEPENDENCY-0FB08978`, 6526455536, `is_test_fixture = true` |
| Dependency | 236 |
| Linked local COs | 146 and 147, including canonical mirrors |
| Synthetic cargo | One transfer line and one local CO line, including its canonical mirror |
| Active catalog entries | Two |

A private full database backup was created and fully read with `pg_restore --file=/dev/null` before mutation. The guarded cleanup first passed under rollback, then committed atomically under the Dispatch planning lock. All unrelated FK cascades, assignments, route stops, driver jobs, completion records and receipts were checked before deletion. Historical unassigned snapshot cards were preserved; no historical route or snapshot was rewritten.

After commit, both transfers, the linked sales/CO records and relevant catalog entries had zero remaining rows. Exactly one `test_fixture_orders_removed` audit was recorded. A repeated apply returned `Already removed; no changes.` After the app deployment, both transfer rows and all relevant catalog entries remained absent, with the audit count still exactly one.

Private backup and operational logs: `/home/ubuntu/operatorapp-deploy-backups/schedule-columns-20260910/`.

## Fresh verification

From the repository root:

```bash
SCM_BROWSER_CACHE=/home/ubuntu/operatorapp-deploy-backups/schedule-columns-20260910/browser-cache \
  bash server/tools/check-schedule-columns.sh
```

The runner can also use its default artifact-local browser cache, installing the existing repository-pinned browser binary when absent. Tests have no production database credentials or network access. The formatting check uses a disposable schema-only PostgreSQL container initialized from actual repository migrations 001, 014 and 083; that container is removed on exit.

| Verification | Final result |
| --- | --- |
| Existing filter/refresh/status/remark checks plus preference tests | 16/16 passed |
| Chromium interaction checks | 6/6 passed |
| Formatting repository harness against isolated PostgreSQL | Passed |
| Generated column-preference cases | 250 cases, seed 20260910, passed |
| Deliberate browser mutations | 3/3 killed by the intended behavior assertions |
| JavaScript syntax | Passed |
| Scoped lint: unreachable code, duplicate arguments/keys, invalid typeof | Passed |
| Scoped secret scan | Passed; no high-confidence findings |
| Whitespace/diff validation | Passed |
| Live served asset byte comparison | All three match the checked source |
| Live app and health endpoint | Healthy, HTTP 200 |
| Runtime environment/mounts/ports/command/user/restart/network comparison | Unchanged |

The six browser checks map to compact rendering/filter retention, draft/selection preservation during hide/save, persistence/user/surface isolation, Show all/reset/last-column handling, read-only keyboard operation, and malformed/unavailable storage. Header/cell geometry is compared after changes and targeted row replacement. Preference properties verify both visibility and hiding requirements for arbitrary stored subsets, rather than only preventing an empty grid.

Mutation checks operate on temporary copies, never the workspace or deployed source. They reintroduce the Type-column display override, remove persistence, or rebuild row editors during a visibility change; each is caught by its intended browser test. Screenshots are saved in `test-artifacts/schedule-columns/`.

Versions: Node 20.20.2, Playwright 1.62.1 / Chromium build 1234, fast-check 4.9.0, ESLint 10.8.0, PostgreSQL 18.

## Failures addressed

- The initial browser run failed all six new scenarios against the old UI.
- A first implementation exposed an existing `.scm-type-cell` `display: flex !important` rule. The hidden-cell rule now takes precedence; the same geometry test then passed.
- The database rehearsal initially rejected a SQL CASE syntax issue and existing NULL unplanned/empty-quantity fields. Those values were inspected before updating the guards; all execution quantity checks remain enforced. No deletion committed during those failed rehearsals.
- An initial formatting baseline lacked a database, and the first isolated setup lacked migration 014. The final runner supplies the real required schema and the unchanged formatting harness passes.
- The browser test scaffold initially omitted a UTF-8 declaration; this was corrected before final screenshots and verification.

## Scope and limits

The full application suite was not run: the change is confined to schedule presentation and one explicitly scoped operational cleanup. No production-connected test harness was executed. Formal changed-line/branch coverage and full frontend TypeScript checking were not collected; this legacy frontend is untyped, and confidence comes from executed browser flows, focused regressions, preference properties and deliberate mutations. Browser coverage is Chromium desktop; other browser/device combinations were not tested. The settings are per browser, not synchronized across devices. No package or lockfile dependency changed, so dependency/license auditing was not repeated.

## Deployed source

Production image: `mbbs-operator-app:schedule-columns-20260910-v1`, image identity `sha256:8f72b679df86106fbc22a7a788cf8fdc2a83447134b16940ca7cbdf3ec97a04f`.

| Asset | SHA-256 |
| --- | --- |
| `public/scm-schedule.js` | `f12bf8e14a6a3b20cb03beae8f90e10f4a437fe61e198c83dbbdd78597fe9e58` |
| `public/dispatch.css` | `555c95c2338aa6024c2fe8dea016cce44e27bf5bfed39850abb124d0bcbe2bd6` |
| `public/scm-schedule.html` | `32be37751906b2aed402bd99e03cfe677ec0c2568466d92cf58130bd1b7e3820` |

Rollback image and Compose overrides are retained with the private deployment records. Database recovery must restore only the deleted fixture rows if ever requested; restoring the entire backup would overwrite subsequent business activity.
