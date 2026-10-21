# Staff alert sound and taskbar badge evidence

Deployed to live MBBS on October 14, 2026 as
`mbbs-operator-app:app-notification-attention-20261014`. Local and public health
and asset checks pass. This follows the user's acceptance of a Windows taskbar
badge with the existing Operator sound, and the prior deployment authorization.

Staff refresh MBBS and click **Enable alert sound** if shown; the sound is also
unlocked by a staff interaction. **Alert sound on/off** mutes the ding and the OS
toast's sound independently of OS-notification permission. The Operator ding
uses the same three triangle-wave notes, timing, pitch ramp and gain envelope.
The OS toast is silent after that ding, preventing duplicate alert sounds.

The taskbar badge uses the browser's App Badging API. Staff install **MBBS Staff**
as an app through Chrome/Edge and open the installed app. Background/unfocused
alerts add unread counts; a visible, focused MBBS staff screen clears them.
The [Chrome/Edge badging documentation](https://developer.chrome.com/docs/capabilities/web-apis/badging-api)
describes installed-app support on Windows. Actual native flashing is outside
the accepted scope; no focus stealing or browser-title animation was added.

Spec: [acceptance criteria](app-notification-attention-20261014-spec.md).
Spec approval was not separately obtained (autonomous follow-up). Verification
establishes the stated behavior, rather than completeness of every business rule.

| Behavior | Executed checks |
| --- | --- |
| Operator waveform, independent mute, quiet OS toast and no repeated ding | Shared alert sound/mute browser test, exact note/ramp/stop assertions, OS `silent` assertions |
| Every existing popup type, including denied OS permission | Four-popup browser test: delivery, regular-stock, delivery-method and PO-reference dialogs |
| One sound and one unread increment across tabs/reloads | Concurrent cross-tab browser test with persisted background state and event receipts |
| Badge clearing only while visible/focused; no focus/title changes | Background/focus browser test, foreground event and unchanged-title/focus-request assertions |
| Playback/OS/badge failure and retry behavior | Blocked audio, failed badge and failed OS delivery test; other channels remain usable and sound is not repeated on an OS retry |
| Logout, delayed sound and private/local boundaries | Delayed audio/logout cancellation, stopped contexts, cleared count; public-account/foreign-link rejection and malformed/bounded count tests |
| Real audio execution | Native Chromium AudioContext test schedules and completes all three oscillator nodes and closes its contexts |
| Installation metadata | Staff manifest identity/scope/icons and sidebar linkage; existing Operator/Driver manifest IDs retained |

The exact release candidate's final fresh run used ten affected delivery and
shared-alert browser files in shuffled order (seed 14102026): **104 tests,
102 passed, two established stock baseline failures, zero skipped**. JavaScript
syntax and scoped lint checks passed with zero warnings and maximum function
complexity 12. Three selected manual mutations were detected and restored:
repeated sound across tabs, clearing the badge while visible but unfocused, and
playing the OS sound after the Operator ding or while muted. Temporary copies
were removed. Browser V8 coverage reports are retained; no complete changed-line
coverage percentage is claimed.

The raw suite exits 1 for the two unchanged stock failures. The wrapper accepts
only their exact names with unchanged test-source hashes, retaining raw failure
logs. They are the existing Wait-for-Transfer JavaScript error and Closed-queue
filtering assertion documented in the
[earlier notification evidence](delivery-timeslot-notifications-20261014-evidence.md).
No assertions were removed or weakened.

Initial RED demonstrated ten missing behaviors on the original handler. The
earlier nine-case RED is also retained. Test setup was refined to persist the
simulated background state across reloads and use a five-second locator timeout;
the completed RED rerun failed all ten cases before implementation. All ten new
cases then passed. Two test-only shadowed variable names were corrected after
lint flagged them; assertions and runtime code were retained before the fresh
full candidate run.

The release changes four public files and preserves **1,381 other runtime files**.
Built-image import and live source verification checked all **1,385 runtime
files**. Runtime configuration, database schema and dependency containers remain
unchanged. Only the app was restarted. Read-only preflight, rollback image and
automatic rollback handling use the established application release helper.
Both local/public health endpoints return 200/ok, four public assets match their
hashes, two anonymous private delivery API requests return 401, and the staff
manifest and versioned sound/notification assets are served.

Reproduce candidate validation or perform read-only live verification:

```sh
python3 server/tools/app-notification-attention-release.py validate
python3 server/tools/app-notification-attention-release.py verify
```

Validation requires the captured base to still be current. The release helper
includes capture/rebase/build/apply phases and preserves source identity and
rollback. `EVIDENCE.json` and the deployment manifest identify the source tree
by SHA-256 and record exact results. Existing locked Node/Playwright tooling is
reused; no dependencies, migrations or commits were added. Dependency/license
auditing and unrelated repository tests were omitted because this is a scoped
browser-only follow-up. The repository's type project does not cover these
browser files; syntax and lint checks apply. No Windows desktop automation,
physical speaker test, cross-browser matrix, closed-app push or performance
benchmark is claimed.

Every test used the standard isolated Compose harness, `mbbs-tests.slice` and
bounded limits with teardown registered before launch. Compose down removed
volumes/orphans, manual image-check containers were removed, both `docker ps`
and `docker ps -a` show only the four production containers, no task test
networks/volumes remain, and production health passes. Source snapshots, logs,
coverage and mutation results remain under
`server/test-artifacts/app-notification-attention-20261014/`; deployment/import/
configuration/preflight/publish/rollback records are in
`server/deployments/app-notification-attention-20261014/`. No disposable database
or browser profile was retained.
