import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [loginSource, controlSource, sidebarSource] = await Promise.all([
  readFile(new URL("../../../public/login.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/control.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/app-sidebar.js", import.meta.url), "utf8")
]);

test("F02/F15: root login maps both MBT authorities to their controlled homes", () => {
  assert.match(loginSource, /mbt_frontdesk\s*:\s*["']mbbs\.staff\.token["']/);
  assert.match(loginSource, /mbt_billing\s*:\s*["']mbbs\.staff\.token["']/);
  assert.match(loginSource, /clean\s*===\s*["']mbt_frontdesk["'][\s\S]{0,100}\/mbt\/frontdesk/);
  assert.match(loginSource, /clean\s*===\s*["']mbt_billing["'][\s\S]{0,100}\/mbt\/billing/);
  assert.match(
    loginSource,
    /payload\.operator\?\.homeRoute/,
    "The browser must honor the server home chosen from primary and secondary authorities."
  );
  assert.match(
    loginSource,
    /payload\.operator\?\.roles[\s\S]{0,300}routeForStaffRole/,
    "The browser fallback must inspect live secondary authorities."
  );
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
