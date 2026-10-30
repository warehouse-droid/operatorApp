The existing gear-button Personal preferences popup offers six additional free
notification sounds: Bottle open, Classic ding, Soft chime, Bell, Digital beep
and Bubble pop. The original Default ding remains available. The sounds are
original Web Audio syntheses with no third-party recordings or downloads.

Choose a sound saves the selection for the account in that browser. Preview
sound plays the selected option. Choosing a built-in sound preserves the user's
uploaded audio as a selectable option; Use default sound resets the preference.
Selections sync across tabs and remain separate for different accounts and
browser profiles. Non-default choices suppress the OS's substitute ding so an
unlocked tab can play the selected sound once. Existing role mutes still apply.

All 38 notification browser checks passed on the workspace and on the exact
release candidate, with no failures or skips. Syntax, ESLint and diff whitespace
checks passed. The checks cover six distinct audible waveforms, volume headroom
and short fades; preview and real alert playback; persistence and cross-tab
changes; retained uploads; invalid files and storage failure; account switching;
late uploads; one OS notice and sound across three tabs on each of two separate
browser contexts sharing an account; role mutes; and the phone layout. The phone
screenshot was also reviewed.

The candidate changes only public/app-alert-sound.js, public/app-notifications.js
and public/app-sidebar.js, preserving 1,423 other runtime files. Image
mbbs-operator-app:notification-sound-presets-20261021 has ID
sha256:cc1753195497bbb1c1d5e43ac90276fd72d629d7992ead3148731d3e3b47d7b3.
The built image's 1,426 runtime files match the candidate, and its server import
check passed. A rollback image is prepared.

Following explicit approval for this addition, the release was published and
verified at 2026-10-21 05:16:56 UTC. All 1,426 live runtime files match the tested
candidate. Local and public health checks returned 200; all three changed public
assets matched their expected hashes, and both protected API checks rejected
anonymous access. Editing leases were retained. The post-deployment audit at
05:17:25 UTC confirmed the new sound-presets image healthy, with the database,
webhook worker and Ollama containers unchanged.

All tests ran in bounded disposable containers under mbbs-tests.slice. The
retention wrapper removed each temporary run directory and its toolchain copy.
Both running and stopped container lists show only the four production
containers; no task test containers, database volumes or test networks remain.
Requested logs and evidence are in
test-artifacts/app-notification-sound-presets-20261021; the candidate, rollback
metadata and final audit are in deployments/app-notification-sound-presets-20261021.
