# Quote memo acceptance specification

User authorization: remove per-item price selection / override reason fields and use one memo below the whole quote total. Proceed autonomously with implementation and the already authorized deployment. Spec approval: not obtained (autonomous run).

Scope: Tier 3 because the removed field currently blocks saving manually entered prices. Reuse the existing quote note property; no database migration, new dependencies, commits, external transactions or NetSuite configuration changes.

Acceptance scenarios:

1. No quote item displays an override-reason input. Desktop and phone layouts show exactly one optional Memo textarea below the quote total. Existing customer notes populate it. Add item remains after the items and per-item subtotals remain visible.
2. Quantity 1 at a rep-entered CAD 2 rate saves with no reason and no memo, producing a CAD 2.26 total at 13% tax. The catalog rate is retained separately as provenance; tax, active-item, numeric input and stale-revision validation still apply.
3. MBR quantity 7 at CAD 50 saves for CAD 395.50 despite a CAD 40 suggested tier. A missing catalog rate permits an explicitly entered price, but blank/invalid prices still fail. Existing snapshots stay immutable.
4. Memo edits persist immediately in device drafts, survive reload/offline editing and remain with the saved revision. Memo text reaches the existing PDF and per-company posting payload paths. Empty memos are accepted. Text is escaped in the UI and bounded by the existing 10,000-character storage limit.
5. Changing item quantities/totals does not replace or lose the memo or the current text cursor. Manually changed rates remain as entered unless the rep explicitly applies a suggested rate.
6. An offline quote syncs its saved rate and memo even if the catalog price changes. A changed tax policy still requires review. Publishing permission and all company split/financial total rules are preserved.

Failure model and checks:

- Removed UI but leftover save guard: repository tests, actual browser save/sync, manual mutant restoring the guard.
- Memo moved outside the form and lost on save/re-render: browser typing, item editing, reload and historical revision checks; mutation of form association.
- Legacy memo or immutable revision data lost: repository round trips, PDF/posting payload assertions, existing offline browser coverage.
- Changed prices silently reset or invalid money accepted: existing exact-money properties and explicit manual-rate/missing-price scenarios.
- XSS via the memo: adversarial textarea-closing text saved/reopened in the browser.
- Bad deployment scope: overlay only the four runtime files on the current image; verify baseline/hash, configuration, health and rollback support.

Setup and verification: use the existing Docker test image and isolated PostgreSQL runner. Run the full Field Sales suite, browser scenarios, ESLint, existing strict domain/pricing type checks, changed-line coverage, three focused manual mutants and randomized suite order. Preserve unrelated dirty workspace changes and identify the final source by SHA-256. No production writes beyond deploying the requested application code.
