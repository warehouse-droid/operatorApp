# Staff notification sound and Windows taskbar badge

User preference: Windows with Chrome or Edge. Reuse the Operator alert sound.
The user accepted a taskbar badge on an installed MBBS app instead of actual
native taskbar flashing. Notifications are required while MBBS is open, including
background tabs. Native Windows flashing and closed-app push are outside scope.

1. Shared delivery, regular-stock, delivery-method and PO-reference alert popups
   can play the Operator's existing three-tone triangle-wave ding. Its notes,
   timing, pitch ramp and gain envelope remain the same. Staff can mute/unmute
   sound independently of OS notification permission.
2. Audio is unlocked by a staff interaction; a blocked/unavailable audio device
   leaves popups and OS notifications usable. Notification permission is requested
   only through the existing explicit OS-notifications button.
3. Sound plays once per account/event across refreshes and tabs. Muted, blocked
   or unavailable sound does not consume an event's future sound delivery. OS
   delivery failures do not prevent sound or consume the OS notification retry.
4. An alert arriving while MBBS is hidden or unfocused increments the installed
   app's taskbar badge once per event. Returning to a visible, focused MBBS screen
   clears the badge. Foreground alerts do not add unread counts. Duplicate notices
   and refreshes cannot inflate the count; local persisted counts are bounded.
5. Badge errors/unsupported browsers leave alerts usable. Logging out or switching
   accounts stops old sound, clears old unread counts and prevents delayed cues
   from the previous session. Verified staff authority and same-origin links
   remain required. No focus-stealing or browser-title flashing is added.
6. Staff pages offer a staff web-app manifest for installation, without replacing
   existing Operator/Driver manifests or service-worker ownership. Chrome/Edge's
   supported badging API controls the installed app icon; this is not a claim of
   native Windows flashing or physical Windows validation on the Linux host.

Setup: preserve the dirty workspace and before snapshots, add no dependencies or
commits, and use the existing bounded isolated Compose harness. Register cleanup
before creating test resources and remove all disposable infrastructure at the
end, retaining logs. Verify the exact release candidate and ship this follow-up
within the user's existing deployment authorization. No database migration.

Verification: RED/green browser acceptance tests for independent sound/mute,
cross-tab deduplication, background badge/focus clearing, playback and badge
failures, logout/account races and native AudioContext execution. Run affected
shared-alert browser regressions and lint/syntax checks. Keep the established
stock baseline failures visible. Selected sound/badge mutations supplement the
assertions; retain coverage and source identity as evidence. Spec approval was
not separately obtained (autonomous continuation of the authorized feature).
