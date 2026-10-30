import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { staffReturnPath } from '../../../public/staff-login-routes.js';

const [loginSource, controlSource, sidebarSource] = await Promise.all([
  readFile(new URL("../../../public/login.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/control.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/app-sidebar.js", import.meta.url), "utf8")
]);

test("F02/F15: root login stores the shared token and honors MBT primary, secondary and server home routes", async () => {
  for (const [role, route] of [['mbt_frontdesk', '/mbt/frontdesk'], ['mbt_billing', '/mbt/billing']]) {
    for (const operator of [{ role }, { role: 'legacy', roles: [role] },
      { role: 'sales', roles: ['sales', role], homeRoute: route }]) {
      const saved = new Map(), visited = [];
      const context = vm.createContext({ staffReturnPath, URLSearchParams, setInterval() {},
        document: { getElementById: () => ({ addEventListener() {}, innerHTML: '' }) },
        localStorage: { setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
        location: { search: '?next=/admin', assign: value => visited.push(value) },
        fetch: async () => ({ ok: true, json: async () => ({ token: 'test-token', operator }) })
      });
      // Preserve the source offsets and filename for native V8 coverage.
      vm.runInContext(loginSource.replace(/^import[^\n]+\n/u, line => line.replace(/[^\n]/gu, ' ')), context,
        { filename: new URL('../../../public/login.js', import.meta.url).pathname });
      await vm.runInContext("signIn({ username: 'test', password: 'test' })", context);
      assert.deepEqual(visited, [route], 'An unauthorized next URL cannot override the permitted home');
      assert.equal(saved.get('mbbs.staff.token'), 'test-token');
      assert.ok(JSON.parse(saved.get('mbbs.staff.roles')).includes(role));
    }
  }
});

test("F02: Admin account management exposes the two explicit MBT authorities", () => {
  assert.match(controlSource, /value:\s*["']mbt_frontdesk["'][\s\S]{0,120}MBT Front Desk/);
  assert.match(controlSource, /value:\s*["']mbt_billing["'][\s\S]{0,120}MBT Billing/);
});

test("F02/F15: the shared sidebar recognizes MBT paths and filters its links by live role", () => {
  assert.match(sidebarSource, /path\.startsWith\(["']\/mbt["']\)/);
  assert.match(sidebarSource, /href:\s*["']\/mbt["']/);
  assert.match(sidebarSource, /href:\s*["']\/mbt\/frontdesk["']/);
  assert.match(sidebarSource, /href:\s*["']\/mbt\/billing["']/);
  assert.match(sidebarSource, /href:\s*["']\/mbt\/config["']/);
  assert.match(sidebarSource, /href:\s*["']\/admin\/mbt-gates["']/);
  assert.match(sidebarSource, /roles\.has\(["']mbt_frontdesk["']\)/);
  assert.match(sidebarSource, /roles\.has\(["']mbt_billing["']\)/);
  assert.match(sidebarSource, /roles\.has\(["']admin["']\)/);
});
