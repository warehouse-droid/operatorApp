# Operator grouped packing and tablet camera recovery

Scope: SOB121625 + SOB121634 must support packing every line. Pallet and
UNI-PISAS-COP-CG are not intentional holds (user clarification). Camera preview
is black on multiple tablets, including after reopening.

Spec approval: not obtained (autonomous run). Tier 3 for draft ownership and
asynchronous camera lifetimes. No new dependencies, commits, or NetSuite writes.
Use existing Node/Playwright containers and a separate test database; preserve
unrelated workspace changes. Production deployment is a separate final action.

Acceptance scenarios:

1. With child A already packed and child B open, confirming B's quantities in
   the group exposes the preparing operator on both group detail and list.
   Current draft identifies the group, so navigation and release use its identity.
2. Confirming the remaining 2 PALLET and 1 pallet + 14 pieces PISAS, then marking
   the group Packed preserves all 7 PALLET and 72 PISAS pieces. Both children
   are packed and no preparing lock remains. Converted rounding stays supported.
3. Another operator cannot edit an owned group. Zero quantity, partial packing,
   standalone orders, transfer groups, loaded quantities and audit rollback
   preserve existing rules. No production quantity is silently repaired.
4. Opening a photo camera uses a tablet-compatible video resolution; high
   resolution still photos continue to use ImageCapture where available.
5. Rerendering a photo screen preserves its playing video element and stream.
   Playback failure or absence of video frames triggers at most one fresh,
   lower-resolution attempt, then a visible retry message, never silent black.
6. Close, navigation, switching, submission and late asynchronous results stop
   obsolete streams; a closed screen never reopens itself. Permission denial
   does not loop. Capture is refused when the fallback video frame is not ready.

Failure model: wrong child selection or release loses draft work (database
integration and browser assertions); stale async camera results seize a device
(late-result tests); video replacement interrupts playback (real canvas video
in Chromium/WebKit); constraints starve video (simulated hardware boundary and
frame timeout); recovery loops (bounded retry/close tests). Physical camera
hardware/OS behavior requires operator verification and is a known limit.

User scope addition: intermittent overlap with Android's bottom navigation bar.
7. Keep the Operator shell within the visible viewport after keyboard, browser
   toolbar, orientation and page-restore changes, without rerendering a camera.
8. Reserve the system safe area plus normal spacing, including a conservative
   48 CSS px Android fallback when inset reporting is unavailable. Photo/return
   screens use remaining flex height rather than hardcoded viewport-minus-header
   calculations; bottom actions remain reachable. Pinch zoom remains enabled.
   CSS and JS asset URLs must agree with the new service worker cache.

Clarification superseding the 48 px fallback in scenario 8: the existing 15 px
gap works normally but is itself covered when Android overlays its bar. Preserve
15 px, position the application above the reported system inset, and respond to
visible viewport/resume changes. Do not add a permanent extra Android gap.

User direction: reproduce the actual failure before applying a fix. Stream
configuration/opening/attachment functions match the September 16 and 25
snapshots and the captured running September 29 release. Native Chromium with
its generated camera reproduced a temporary (~1.5 second) blank on photo-slot
clicks, then recovered; all three reopen attempts succeeded. This does not
reproduce persistent black across physical tablets. No production deployment.
The speculative five frontend changes are withdrawn from runtime files and
saved in test-artifacts/operator-group-camera/unproven-frontend-proposal.
The camera regression additions currently describe that withdrawn proposal;
they are not evidence that the reported tablet fault is fixed. The grouped
packing draft and its six passing focused database tests remain separate.

Environment clarification: affected tablets open the installed home-screen app.
Extend diagnosis to a real installed Chromium PWA with the shipped service
worker, then background/resume and relaunch. Desktop PWA reproduction still
does not emulate Android hardware or its system navigation bar. A same-tablet
Chrome-tab comparison is requested to distinguish installed-app behavior.

Diagnostic result: actual installed desktop Chromium PWA (standalone verified,
real shipped service worker controlling the page), generated native camera:
Delivery and Receiving previews worked on open, three close/reopen attempts,
three freeze/resume cycles, and app-window close/relaunch. This does not prove
Android camera behavior. Existing CSS also accommodated native Chrome safe-area
overrides of 0/24/48 px at heights 800/560, with at least 27 px between Receive
and the emulated system area. Neither persistent physical-tablet symptom is
reproduced. Record the same-tablet normal Chrome-tab result next; do not treat
resolution reduction, a larger fixed margin, or cache clearing as established
fixes. Evidence: test-artifacts/operator-group-camera/investigation-status.json.

Deployment authorization: user explicitly requested "deploy then". The final
release contains only src/delivery-repository.js; camera and Android spacing
proposals remain withdrawn pending physical-tablet reproduction. The additional
standalone draft regression verifies its original identity, owner, line count,
and unchanged persisted quantities.

Deployed 2026-09-29 23:39 UTC as
mbbs-operator-app:operator-group-packing-20260929-v1. Built from the latest live
regular-stock-delivery-simple image, flattening its 391 layers after Docker's
mount-options limit prevented another layer. Image settings were preserved and
all 1,143 src/public/migration files were verified, with exactly one changed.
The first build exposed a COPY file-permission issue, corrected before testing
or deployment by preserving access for the node runtime user.

Final release checks: seven focused packing tests pass. The scoped broader
suite passes 59 of 60 tests, with the exact same existing cache-version test
failure verified on the parent image; no new failures and no skipped cases.
The initial broader run lacked MBT_TEST_ISOLATED, so protected fixtures refused
to run. The harness now verifies the disposable database URL and sets that flag;
no fixture guard was removed. Original-image checks reproduce all three group
identity/ownership failures. Four manual mutations are killed; owner and draft
mutations also fail the property test alone (seed 20260929, 12 runs). Changed-line
coverage is 28/28. Scoped syntax passes; lint diagnostics remain 8/8 and noResolve
type diagnostics 703/703, with no new diagnostics. This is scoped verification,
not a claim that the whole repository or all existing diagnostics are clean.

Local and public health return 200, Operator page returns 200, anonymous order
access remains 401, app configuration is preserved, and dependencies were not
restarted. Read-only live inspection after deployment confirms SOB121625 is
packed and SOB121634 is open, with 5/7 PALLET and 22/72 PISAS currently packed.
The operator must confirm the remaining quantities through the normal flow;
deployment did not repair quantities or post to NetSuite. Current live group has
no preparing owner, so its active draft projection is verified in isolated tests.
Release command: python3 server/tools/operator-group-packing-deploy.py test,
followed by apply; exact source hash and all run details are in the release's
verified.json and test-artifacts/operator-group-camera/deployment-evidence.json.

2026-09-30 escalation: user reports Android's normal Camera app works after a
reset until Operator opens its camera; thereafter all camera use fails until
another reset. Multiple Android tablets are affected; Windows tablets work.
User requests line-by-line review and rollback. This authorizes a scoped camera
rollback and deployment while preserving the packing fix. Spec approval was not
separately obtained (autonomous run under that instruction).

Camera rollback acceptance:
1. Android returns to the browser-selected dimensions and canvas still capture
   used before 14fe19a (reference 9877ca1), with no maximum sensor negotiation or
   forced autofocus. Existing screen flows and Windows capture quality remain.
2. An acquired stream is reachable by cancellation before any asynchronous
   preparation. Closing, leaving or pagehide stops it even if applyConstraints
   never resolves. A late result cannot replace or stop a newer camera.
3. A hidden app releases photo/scanner/inventory streams; rerendering while
   hidden cannot reopen them. Foreground entry can open its current photo flow.
4. NotReadableError, AbortError and permission errors do not trigger device
   fallback retries. Unsupported facing/device constraints retain fallback.
5. Capture and close/reopen work with the real Chromium video pipeline, and the
   installed app receives matching versioned assets through its service worker.
6. Release changes only camera JavaScript and the corresponding HTML/cache
   versions. Backend, order quantities, uploads and the existing 15px spacing
   remain unchanged. Preserve a rollback image and verify deployed asset hashes.

Failure model: pending stream ownership leaks a device (controlled unresolved
platform-promise regression); a hidden window competes with native Camera
(visibility lifecycle regression); fallback retries intensify a device error
(boundary error matrix); stale success corrupts the new stream (ordering property
and mutation checks); Android quality negotiation differs from historical simple
capture (request and still-capture assertions); cache serves old code (installed
PWA upgrade test). Physical Android camera-service behavior remains a known limit.
Use existing containers and packages; no dependencies, commits or database writes.

Camera rollback deployment completed 2026-09-30 00:38 UTC. Release image:
mbbs-operator-app:operator-camera-rollback-20260930-v1. Camera asset/cache version:
20260930-android-camera-rollback-v1. The release changes operator.js, operator.html,
and service-worker.js only; all 1,143 runtime source/public/migration hashes were
verified. Public and local assets match the candidate, both health checks return
200, app configuration and dependency containers are preserved. Packing backend
and existing bottom spacing are unchanged.

Final scoped verification: 21 unit checks, 5 full-screen native Chromium tests,
and 4 existing photo-flow browser checks pass (30 total). Five manual mutants
and two property-only mutants are killed. Property seed 20260930, 12 runs. All
34 changed JavaScript lines and 18 changed V8 branch ranges are covered. Syntax
passes; lint remains 38 diagnostics and noResolve types remain 1320 diagnostics,
with no new diagnostics. Eight prior speculative preview/layout tests were not
selected because their implementation was withdrawn; no claim of a clean whole
repository suite is made.

Installed standalone Chromium PWA, Android-mode user agent and generated native
camera: new service worker cache active; initial camera, three close/reopen
attempts, orientation changes, page restore, three freeze/resume cycles and app
close/relaunch all show frames with zero page errors. Screenshot inspected.
This validates the browser pipeline and installed asset version, not a physical
Android camera service. The original baseline fails both full-screen cleanup
reproductions (pending preparation and background release). Exact afternoon onset
and physical-tablet recovery remain unconfirmed. Android basic capture can have
lower image resolution; Windows capture mode remains unchanged.

The first stale-request mutant exposed incomplete callback ordering in the
property, which now settles all old preparation stages while the new stream
is pending. An explicit MediaStream|null type fixed two new static diagnostics
before deployment. Full records, known limits and code-review locations are in
test-artifacts/operator-camera-rollback/deployment-evidence.json and code-review.json.

2026-09-30 follow-up: user confirms Android still locks the camera, Windows
releases it, and clearing cache plus force-stopping Chrome restores native Camera.
The preceding deployment did NOT resolve the physical-device problem. They also
report default layout content outside the Android screen. New autonomous scope:
- Android photo buttons use the OS camera capture input, with zero getUserMedia
  calls on entry, capture, return from the camera, or app resume. Delivery, pickup,
  consolidation, Receiving, Returns and Damage must retain their photo validation.
- Native capture cancellation changes no photos; late photos cannot attach to a
  different order, evidence target or damage report. Photo barcode scanning uses
  the existing decoders without opening a LiveStream. Windows inline capture stays.
- Detach video elements when stopping or replacing them, as well as stopping tracks.
- Fit default layout to remaining shell height, keep final actions on screen and
  permit scrolling inside long-content panels. React to visual viewport resize;
  retain 15px spacing plus reported safe-area inset. Verify landscape and portrait
  tablet sizes including a short landscape viewport and long order contents.
- Keep packing backend, posting rules, quantities, API and dependency containers.
  Version all changed PWA assets, deploy scoped overlay with rollback and compare
  public hashes. No new dependencies, commits, live business writes or device access.
Failure model: background events cancel a legitimate OS photo (event-order tests);
stale photo changes another order (ordering properties); a forgotten camera entry
locks Android (all entry point checks); long content hides final actions (geometry
and screenshots); old PWA cache retains bug (upgrade test); Windows regresses
(existing browser pipeline suite). Exact physical Android driver behavior and OS
navigation-bar geometry remain unverifiable without the affected device.
Spec approval: not obtained (autonomous run under existing fix/deploy instruction).

User explicitly cancelled layout work ("ignore the layout issue"). Retain the
layout reproduction artifacts but exclude CSS, viewport behavior and layout tests
from this release. Camera scope continues; no layout implementation was made.
Device confirmed: ONERUGGED M10T, Android 14, landscape.

User comparison: webcamtests.com can open and stop its camera, then the native
Camera app works. This narrows the fault to Operator-triggered capture behavior;
it does not support blaming Android generally. Same rear-camera comparison is
pending. The native-capture release is a workaround, not proof of the precise
M10T failure trigger. Layout reproduction archived as an explicitly-run tool only.

Device detection follow-up: Chrome documents Android tablet desktop mode reporting
Linux in both User-Agent and client hints. The prior Android-only gate misses this
mode (browser regression observed getUserMedia=1 where zero is required). Include
Linux-reporting touch devices in native capture; Windows touch and Linux devices
without touch retain streaming. Installed-app check now exercises Linux desktop UA
with touch enabled. Actual M10T desktop-mode setting remains unconfirmed. This
heuristic also selects native capture/file input on real Linux touch devices.
Source: https://developer.chrome.com/blog/desktop-mode

Android native camera workaround deployed 2026-09-30T01:29:33.855460+00:00 as mbbs-operator-app:operator-android-native-camera-20260930-v2.
Final fresh run: 26 unit + 12 browser + 2 historical Windows cases = 40 pass.
Six manual mutants and three property-only mutants killed. Changed lines 143/143;
V8 branch ranges 96/96. Lint unchanged at 38; scoped type diagnostics 1482 -> 1448,
zero added. Installed PWA upgrades old v1 to v2, captures two fixture photos with
zero getUserMedia requests, no page errors. Source hashes and all evidence in
test-artifacts/operator-android-camera-release/deployment-evidence.json.
Physical M10T recovery remains awaiting user confirmation.


2026-09-30 Android navigation follow-up:

The user confirms the native-camera workaround is good. They reopened only the
Android bottom-bar issue: an installed M10T app in landscape uses Back/Home/Recent
buttons; closing and reopening restores the existing 15px gap, but loading or
redrawing a screen can let the application drop behind the bar again.

The narrow workaround retains the working launch height outside the replaced
screen DOM and across reloads within the same window. It also follows a smaller
visual viewport, orientation/width changes and reported system insets. Keep the
15px gap; do not add a permanent 48px fallback. Windows and ordinary browser tabs
retain their existing behavior. Camera scripts and packing code remain unchanged.

Executable check: simulate a correct 752px launch followed by an 800px viewport
that includes a 48px navigation overlay, then redraw menu, delivery, receiving and
return screens and reload. The content boundary must remain at 737px. Separately
check reported insets without double subtraction, keyboard recovery, pinch zoom,
Android desktop mode and Windows. These are controlled browser simulations; the
physical tablet transition and the assumption of a correct launch height still
require user verification after deployment.


Bottom-bar release outcome: deployed 2026-09-30 02:33 UTC as
`operator-android-bottom-bar-20260930-v1`. All 24 focused browser checks pass
(10 viewport, 12 Android capture, 2 Windows camera), with zero lint/type diagnostics
in the new module. A real Chromium installed PWA updated its cache, loaded the
viewport helper offline and accepted two native-capture fixture photos without
opening a browser stream. All 1,144 runtime file hashes and the four changed public
assets were verified after deployment. M10T physical bottom-bar confirmation is
pending. Camera and packing code hashes are unchanged.
