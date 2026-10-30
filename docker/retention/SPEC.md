# Host artifact retention

User authorization (21 October 2026): delete old test artifacts, keep the latest
five deployment copies, remove future test artifacts at the end of each run,
and leave live containers and databases unaffected. The source checkpoint was
pushed and the user confirmed that the full database backup was downloaded.

Tier 3, because deletion is irreversible. Spec approval: not obtained
(autonomous run); the user's retention and protection requirements authorize
the work. No new Python dependencies. Use the standard library and bounded,
disposable Docker tests. Keep this specification and the small operational
cleanup journal; generated test data is disposable.

Acceptance scenarios:

1. Across both deployment roots, retain exactly the newest five complete copies
   (or all when fewer than five exist), ordered by original directory mtime and
   path. Older copies may leave small tracked records and live configuration.
2. Only the explicitly configured roots are eligible. Reject symlink roots;
   never follow symlinks or cross filesystems. Keep files referenced by live
   container mounts and Compose labels, tracked Git files, operational audit
   records, and production database snapshots found among test artifacts.
3. A dry run does not delete anything. Changed files/directories invalidate a
   saved deletion plan. Revalidate before deletion; do not recursively follow a
   directory substituted by a symlink. Refuse empty/zero-copy retention.
4. Recent test directories and paths in use by a process/container are excluded
   from periodic sweeps. Each new test run uses a unique artifact directory and
   an outer runner that removes that directory on success, failure, or TERM/INT.
   The runner preserves the child exit status and waits for the child to exit.
5. Test fixtures demonstrate ordering, ties, 0..20 copies, protected descendants,
   outside sentinels, symlinks, changed-plan rejection, recent activity, repeated
   sweeps, and cleanup after successful/failed/interrupted child commands.
6. The retention command only reads Docker state. It never stops, removes,
   recreates, or modifies any container, image, network, or volume. Missing
   production containers or unhealthy production health checks stop the sweep.
7. Install an hourly bounded sweep for old artifacts and deployment copies.
   New test commands use the disposable-run wrapper for immediate cleanup.
   Existing full-database-backup retention remains at five backups.

Failure model: over-broad paths (allowlisted roots and sentinel tests), wrong
ordering (exhaustive retention tests), active work (recent/use guards and run
leases), symlink substitution (no-follow descriptor traversal and race tests),
stale plans (tree fingerprints), production disruption (read-only Docker calls
and before/after identity/health verification). SIGKILL cannot run a finally
handler; the periodic sweep recovers abandoned runs after the age threshold.

Clarification: use a two-hour inactivity guard for historical test folders and
deployment copies being prepared by other sessions. Active disposable runs also
hold a PID/start-time lease, so long-running tests survive the periodic sweep.
Live Compose references and operational records may remain as small metadata-only
directories after an old complete deployment copy is removed.

Additional periodic-run invariant: keep the three configured cleanup root
directories themselves, including when empty. Remove eligible loose artifacts
within them so a second sweep succeeds and has no further work.

Verification: isolated unittest suite, Python compile checks, trace coverage,
five manual mutants, live dry run, reviewed deletion manifest, actual cleanup,
container identities and health before/after. No whole-application test run is
needed: application source and database schemas are not changed by this work.
