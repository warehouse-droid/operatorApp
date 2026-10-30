# TOB0126 search: reproduction before implementation

Reproduced both reported symptoms on 2026-10-28. This task changes diagnostic
tools and evidence only. No application fix, deployment, migration, production
order edit, or additional refresh mechanism is included.

## Live backend observation

Two calls to the live `loadDispatchOrdersForResponse` with
`{search:'TOB0126', includeCompletedScmSearch:true}` returned all ten references
TOB01260–TOB01269, including unplanned TOB01263–TOB01266. Elapsed times were
24,563 ms and 23,515 ms. Connections were forced read-only with a 45-second
statement timeout. This invokes the search route's actual loader but excludes
HTTP/authentication/network overhead.

The second call used callback-aware `pg` instrumentation. The main
`listDispatchOrders` SQL took 23,030 ms and returned ten rows. Its other
invocation took 5,323 ms; snapshot lookup took 4,843 ms; reconciliation lookup
took 2,920 ms and returned 15,013 rows. These overlap, so their durations must
not be added. The first diagnostic query wrapper did not measure callback-style
queries correctly; only its overall 24,563 ms elapsed time is retained.

This identifies the database search as the dominant measured delay. It does
not yet establish which query-plan operation should be optimized. The earlier
September 30 search-session evidence also recorded 17.8–31.7 second searches;
slowness predates this investigation.

Run the read-only operational probe from the repository root:

```bash
sudo -n docker exec -i -w /app/tools mbbs-operator-app-app-1 node --input-type=module < server/tools/dispatch-tob-search-profile.mjs
```

## Controlled browser reproduction

The complete, unmodified live `dispatch.js` and its actual authentication,
address-guard and edit-activity helpers ran in isolated Chromium. Login/bootstrap
and API responses are boundary fixtures. The search fixture uses the ten live
reference identities and planned/unplanned flags, without production cargo or
credentials. Initially only today's planned TOB01268 and TOB01269 are loaded;
the active browse tab is SO, as on the default screen. The search response is
held until the specified event, then the same ten-order response is delivered.
The real input handler, search loader, update queue, merge/filter logic and DOM
renderer execute unchanged. This is an isolated reproduction of the symptom,
not a captured trace from the dispatcher's original browser session.

| Condition | Actual cards after search finishes | Loading/error state |
| --- | --- | --- |
| No intervening update | All ten | Finished; no error |
| Unrelated order update while search waits | Only TOB01268 and TOB01269 | Finished; no error |
| Local plan edit while search waits | Only TOB01268 and TOB01269 | Finished; no error |
| Same order update finishes before search starts | All ten | Finished; no error |

Both failing scenarios also retry the identical search with no intervening
update. Both then show all ten. Assertions verify the actual rendered cards,
not merely the internal order array. Browser errors must be absent.

The difference is timing. `queueDispatchOrderPoolRefresh` increments the global
order-read epoch, including for unrelated order updates. `markLocalPlanDirty`
increments the local-plan generation. `loadDispatchOrderSearch` rejects its
response when either value changes, before merging any of the ten returned
orders. Its `finally` block nevertheless clears `orderSearchLoading` and renders
the ordinary successful-results subtitle. The order update's normal browse
refresh requests the active SO tab without the search term, so it does not
complete the TO search. The screen is left showing only whatever matching cards
were already loaded. There is no planned-only search filter in `openOrders`.
The long backend wait creates a larger opportunity for this timing condition.

Reproduce with the unchanged live assets:

```bash
sudo -n bash docker/reproduce-dispatch-tob-search.sh
```

Machine-readable observations and exact live image/source hash are in
[dispatch-tob-search-reproduction-20261028.json](dispatch-tob-search-reproduction-20261028.json).
The diagnostic deliberately asserts the existing failure; a successful run
means the bug was reproduced, not fixed. No application assertions were weakened.
Full regression, mutation, coverage and static-delta checks are not applicable
to this reproduction-only phase; no implementation has been written.

## Isolation and cleanup

The repository retention runner creates a unique artifact directory and removes
it after teardown. The browser uses the standard isolated Compose configuration,
`mbbs-tests.slice`, init, memory/CPU/PID/tmpfs limits and a disposable-test label.
No test database is launched. Teardown is registered before container creation
and uses `down --volumes --remove-orphans`; both `docker ps` and `docker ps -a`,
owned volumes/networks and live health are checked. Browser source copies and
raw temporary output are removed; only this concise evidence remains.

Harness setup initially omitted a Compose profile and the screen's edit-activity
helper. A waiting harness was stopped, removed and cleaned up; these setup errors
were corrected before the reported successful reproduction. They are not
application failures.
