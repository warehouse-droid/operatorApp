# Stock request conversations

User scope: Special Request, Regular Backorder, Regular Stocking (Transfer and Purchase), and Regular Delivery. Replace Ask Sales / request-information and scattered reply editors with one Sales–SCM conversation panel patterned after Delivery Request.

Only explicitly typed conversation messages appear. Author, role, time and optional material context accompany messages. Automated audit/status/approval/stock-check notes and private notes never become conversation text. Preserve legacy questions and replies. Audit history remains available separately.

Both authorized parties may start or continue a conversation. Messages do not create orders or change approval/fulfillment decisions. A Sales reply must still resolve a legacy pending information request. Legacy Stocking waiting-for-reply markers remain consistent when replying. Current yard/access and Special workflow gates apply to reads and writes. Closed requests retain read-only history.

Use an operation ID to make retries idempotent; reject changed content with the same ID. Preserve drafts through polling, re-rendering, switching requests and failed sends. Escape message HTML. Refresh only conversation messages when new replies arrive. Show clear validation and failure messages.

Failure model: confidential messages exposed across yards/roles (HTTP and repository tests); automated/private notes leaked into chat (allowlist unit/property tests); duplicate or lost messages (concurrent retries and browser failed-send tests); stale responses showing the wrong request (browser switch test); XSS (browser escaping); old pending workflows stranded (integration tests); changing order state (before/after assertions); disrupting the live host (bounded disposable Compose with finally teardown).

Use old-coder Tier 3 for authenticated shared records. Behavior authorized by the user's request; detailed spec approval not obtained (autonomous run). No new dependencies or schema migrations. Reuse existing event journals and role middleware, existing Node/PostgreSQL/Playwright/ESLint/TypeScript/c8/fast-check tools. Preserve unrelated workspace/live changes with a scoped patch over captured live source. No live message is sent during validation. Keep evidence and rollback artifacts; remove every test container, database volume and network.

Revision 1 — user explicitly added new-message notifications. Add one read-receipt table and a partial event index, with no existing business data changes. Only new typed messages trigger alerts; existing legacy history does not generate a backlog on rollout. Alert recipients are authorized users on the receiving side; the sender never receives their own alert. Counts persist per operator, and marking a visible conversation read acknowledges only the displayed messages, never a later arrival. Badge, in-app notice and existing browser notification preferences apply.
