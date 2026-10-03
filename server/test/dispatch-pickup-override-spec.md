# Pickup override grouping (Tier 2)

SOA09326 has source yard 2967 and a saved pickup override of
195 Milner Ave, Scarborough, ON M1S 3R1. Adding it alongside SOA09464
must create a separate pickup at the override address, retaining 2967 as
the inventory allocation key. Dispatch cards and Driver jobs must show
the override. Orders with the same override may still share a pickup.

Changing an override on a shared, unstarted pickup must separate affected
orders during save preparation. Repeating preparation must be idempotent.
Driver activity protects the entire executed route prefix, including pickup
allocations. Late-order insertion, pickup splitting and SCM reconciliation
must not merge different override addresses into one visit.

Setup: use existing Node/Docker test tools, isolated Postgres, Playwright,
ESLint, TypeScript and c8. No dependencies, database migrations, production
data edits, Git commits or staging. Capture the current source baseline,
run failing regressions before implementation, adjacent pickup tests,
static comparison, coverage and manual mutations. Deploy only verified
pickup files over the current app image and check served assets/health.

Spec approval: not obtained (autonomous run, within the requested fix).
Conservative address matching ignores case, punctuation and spacing; distinct
override spellings that are not equivalent under that rule may remain separate.

## 3 October 2026 deployment and source snapshot

The user explicitly authorized deploying the pickup-address fix, then committing and pushing. This replaces the earlier no-staging/no-commit restriction for this task. GitHub branch verification shows codex/dockerVer is the active branch; no dockerV2 branch exists. Use the existing branch unless the user redirects it.

Rebase the four-file release onto the current BOSS rejection image, preserving all later deployed features. Run the exact candidate's pickup/browser tests, compare adjacent/static diagnostics to the captured current live baseline, verify coverage and existing mutation checks, and retain BOSS regressions. No new production behavior, dependencies or schema changes are planned. Verify public assets and health after an app-only restart. Capture the resulting app and current worker source for a Git snapshot, scan staged content for secrets, preserve unrelated working files, and push without force to the confirmed branch.
