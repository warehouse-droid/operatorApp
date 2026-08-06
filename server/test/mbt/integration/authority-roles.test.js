import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import {
  createOperator,
  getOperatorByToken,
  loginOperator,
  OPERATOR_ROLES,
  operatorHomeRoute
} from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";

const USERNAMES = [
  "mbt-p1-frontdesk",
  "mbt-p1-billing",
  "mbt-p1-secondary-frontdesk",
  "mbt-p1-secondary-billing"
];

before(async () => {
  await query("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))", [USERNAMES]);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [USERNAMES]);
});

after(async () => {
  await query("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))", [USERNAMES]).catch(() => null);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [USERNAMES]).catch(() => null);
  await closeDb();
});

test("F02: MBT Front Desk and Billing are explicit operator authorities", () => {
  assert.ok(OPERATOR_ROLES.includes("mbt_frontdesk"));
  assert.ok(OPERATOR_ROLES.includes("mbt_billing"));
});

test("F02 non-regression: every existing primary authority keeps its original home route", () => {
  const expectedRoutes = new Map([
    ["operator", "/operator"],
    ["dispatcher", "/dispatch"],
    ["admin", "/admin"],
    ["scm", "/scm"],
    ["scm_staff", "/scm"],
    ["yard_manager", "/control"],
    ["sales", "/sales"]
  ]);
  for (const [role, expectedRoute] of expectedRoutes) {
    assert.equal(operatorHomeRoute({ role, roles: [role] }), expectedRoute, role);
  }
});

test("F02: MBT home routing is normalized, deterministic, and never overrides an established primary home", () => {
  const cases = [
    {
      label: "normalized primary Front Desk",
      authority: " MBT-Frontdesk ",
      expected: "/mbt/frontdesk"
    },
    {
      label: "primary Billing",
      authority: { role: "mbt_billing", roles: ["mbt_billing"] },
      expected: "/mbt/billing"
    },
    {
      label: "secondary Front Desk",
      authority: { role: "operator", roles: ["operator", "mbt_frontdesk"] },
      expected: "/mbt/frontdesk"
    },
    {
      label: "secondary Billing",
      authority: { role: "operator", roles: ["operator", "mbt_billing"] },
      expected: "/mbt/billing"
    },
    {
      label: "both secondary MBT roles use stable Front Desk precedence",
      authority: { role: "operator", roles: ["operator", "mbt_billing", "mbt_frontdesk"] },
      expected: "/mbt/frontdesk"
    },
    ...[
      ["admin", "/admin"],
      ["dispatcher", "/dispatch"],
      ["scm", "/scm"],
      ["yard_manager", "/control"],
      ["sales", "/sales"]
    ].map(([role, expected]) => ({
      label: `${role} primary wins over secondary MBT roles`,
      authority: { role, roles: [role, "mbt_frontdesk", "mbt_billing"] },
      expected
    })),
    {
      label: "ordinary operator",
      authority: { role: "operator", roles: "not-an-array" },
      expected: "/operator"
    },
    { label: "unknown authority", authority: "mbt_unknown", expected: "/" },
    { label: "missing authority", authority: null, expected: "/" }
  ];

  for (const { label, authority, expected } of cases) {
    assert.equal(operatorHomeRoute(authority), expected, label);
  }
});

test("F02: MBT primary roles survive create, login, and live-session lookup", async () => {
  const fixtures = [
    { username: USERNAMES[0], role: "mbt_frontdesk", homeRoute: "/mbt/frontdesk" },
    { username: USERNAMES[1], role: "mbt_billing", homeRoute: "/mbt/billing" }
  ];

  for (const fixture of fixtures) {
    const created = await createOperator({
      username: fixture.username,
      displayName: fixture.username,
      password: "phase-one-test",
      role: fixture.role,
      roles: [fixture.role]
    });
    assert.equal(created.role, fixture.role);
    assert.deepEqual(created.roles, [fixture.role]);
    assert.equal(created.homeRoute, fixture.homeRoute);

    const loggedIn = await loginOperator(fixture.username, "phase-one-test");
    assert.match(loggedIn.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(loggedIn.operator.homeRoute, fixture.homeRoute);
    assert.deepEqual(loggedIn.operator.roles, [fixture.role]);

    const live = await getOperatorByToken(loggedIn.token);
    assert.equal(live.homeRoute, fixture.homeRoute);
    assert.deepEqual(live.roles, [fixture.role]);
  }
});

test("F02: secondary MBT authorities route a generic operator to the controlled home", async () => {
  const fixtures = [
    {
      username: USERNAMES[2],
      secondaryRole: "mbt_frontdesk",
      homeRoute: "/mbt/frontdesk"
    },
    {
      username: USERNAMES[3],
      secondaryRole: "mbt_billing",
      homeRoute: "/mbt/billing"
    }
  ];

  for (const fixture of fixtures) {
    const created = await createOperator({
      username: fixture.username,
      displayName: fixture.username,
      password: "phase-one-test",
      role: "operator",
      roles: ["operator", fixture.secondaryRole]
    });
    assert.equal(created.role, "operator");
    assert.deepEqual(created.roles, ["operator", fixture.secondaryRole]);
    assert.equal(created.homeRoute, fixture.homeRoute);

    const loggedIn = await loginOperator(fixture.username, "phase-one-test");
    assert.equal(loggedIn.operator.homeRoute, fixture.homeRoute);
    assert.deepEqual(loggedIn.operator.roles, ["operator", fixture.secondaryRole]);

    const live = await getOperatorByToken(loggedIn.token);
    assert.equal(live.homeRoute, fixture.homeRoute);
    assert.deepEqual(live.roles, ["operator", fixture.secondaryRole]);
  }
});

test("F02: an unknown authority remains rejected", async () => {
  await assert.rejects(
    () => createOperator({
      username: `mbt-invalid-${crypto.randomUUID()}`,
      displayName: "Invalid MBT role",
      password: "phase-one-test",
      role: "mbt_superuser"
    }),
    /invalid primary operator role/i
  );
});
