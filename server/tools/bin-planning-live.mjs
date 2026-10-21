// Read-only business probes. A temporary diagnostic login is removed in finally.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { query, withTransaction, closeDb } from "../src/db.js";

const id = randomUUID();
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const bases = ["http://127.0.0.1:3000", "https://test.mbbsoperation.com"];
const report = { endpoints: [], servedAssets: 0, diagnosticLoginRemoved: false, noEditLeaseAcquired: false };
const files = ["dispatch.html", "dispatch.js", "dispatch.css", "mbt-home.js", "mbt-planning.html", "mbt-planning.js", "mbt-planning.css"];
const sha = body => createHash("sha256").update(body).digest("hex");
const planState = async () => (await query(`SELECT p.id,p.revision,md5(to_jsonb(s)::text) AS snapshot
  FROM dispatch_plans p LEFT JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.plan_date=$1::date`, [date])).rows;
const before = await planState();
try {
  await withTransaction(async () => {
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
      VALUES($1,$2,'Temporary BIN release verification',$3,$4,'dispatcher',ARRAY['dispatcher'],true)`,
    [id, `bin-release-check-${id}`, randomBytes(64).toString("hex"), randomBytes(32).toString("hex")]);
    await query("INSERT INTO operator_sessions(token_hash,operator_id,expires_at) VALUES($1,$2,now()+interval '5 minutes')", [tokenHash, id]);
  });
  for (const base of bases) {
    for (const file of files) {
      const route = file === "dispatch.html" ? "dispatch/planning" : file === "mbt-planning.html" ? "mbt/planning" : file;
      const response = await fetch(`${base}/${route}?v=20260927-bin-planning-v1`, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200, route);
      let body = Buffer.from(await response.arrayBuffer());
      if (file.endsWith(".html") && base.startsWith("https:")) {
        body = Buffer.from(body.toString().replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/gu, ""));
      }
      assert.equal(sha(body), sha(readFileSync(`/app/public/${file}`)), `Served asset ${route}`);
      report.servedAssets++;
    }
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15000) });
    assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
    for (const path of [`/api/mbt/planning?planDate=${date}`, `/api/dispatch/plan-edit-lease?planDate=${date}`]) {
      assert.equal((await fetch(base + path, { signal: AbortSignal.timeout(15000) })).status, 401, path);
    }
    for (const path of [`/api/mbt/planning?planDate=${date}&limit=10`, `/api/dispatch/v2/bootstrap?date=${date}`,
      `/api/dispatch/plan-edit-lease?planDate=${date}`]) {
      const start = performance.now();
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200, path);
      const body = await response.json();
      if (path.startsWith("/api/mbt/")) {
        assert.equal(body.planDate, date); assert.ok(Array.isArray(body.pool.items)); assert.ok(Array.isArray(body.drivers));
      }
      report.endpoints.push({ base, path, status: response.status, elapsedMs: Math.round(performance.now() - start) });
    }
  }
  assert.deepEqual(await planState(), before, "Read-only probes must preserve the daily plan");
  assert.equal((await query("SELECT count(*)::int n FROM dispatch_plan_edit_leases WHERE operator_id=$1", [id])).rows[0].n, 0);
  report.noEditLeaseAcquired = true;
  report.dailyPlanUnchanged = true;
} finally {
  await query("DELETE FROM operator_sessions WHERE token_hash=$1 AND operator_id=$2", [tokenHash, id]);
  await query("DELETE FROM operators WHERE id=$1 AND username=$2", [id, `bin-release-check-${id}`]);
  report.diagnosticLoginRemoved = (await query("SELECT id FROM operators WHERE id=$1", [id])).rowCount === 0;
  await closeDb();
}
console.log(JSON.stringify(report));
