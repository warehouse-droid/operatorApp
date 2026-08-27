/* global caches, document, indexedDB, localStorage, navigator, Response, sessionStorage */
import { expect, test } from "./mbt-e2e-test.js";

const ACTIVE_CACHE = "mbbs-driver-shell-v38";
const OLD_DRIVER_CACHE = "mbbs-driver-shell-v26";
const OPERATOR_CACHE = "mbbs-yard-operator-cache-repair-probe";
const PROBE_DB = "mbbs-driver-cache-repair-probe";
const HARD_RESET_CACHE = "mbbs-driver-hard-reset-cache-probe";
const HARD_RESET_DB = "mbbs-driver-hard-reset-db-probe";

test("iPhone Driver advertises hard reset only on the version-update-required screen", async ({ page }) => {
  await page.goto("/driver");
  const resetLink = page.locator('a[href="/reset-driver"]');
  await expect(page.getByRole("heading", { name: "Driver Login" })).toBeVisible();
  await expect(resetLink).toHaveCount(0);

  await page.evaluate(() => {
    localStorage.setItem("mbbs.driver.requiredPwaVersion", JSON.stringify({
      currentVersion: "2026.08.12.99",
      minimumVersion: "2026.08.12.99",
      reason: "reset-discovery-e2e"
    }));
  });
  await page.reload();

  await expect(page.getByRole("heading", { name: "Driver PWA update required" })).toBeVisible();
  await expect(resetLink).toHaveCount(1);
  await expect(resetLink).toBeVisible();
  await expect(resetLink).toHaveText("Hard reset this Driver site");
});

test("iPhone Driver cache repair preserves IndexedDB/login data and other MBBS caches", async ({ page }) => {
  test.setTimeout(90_000);

  await page.addInitScript(() => {
    localStorage.setItem("mbbs.driver.token", "cache-repair-login-probe");
    localStorage.setItem("mbbs.driver.offlineModeEnabled", "true");
    localStorage.setItem("mbbs.driver.requiredPwaVersion", JSON.stringify({
      currentVersion: "2026.08.12.99",
      minimumVersion: "2026.08.12.99",
      reason: "cache-repair-e2e"
    }));
  });

  await page.goto("/driver");
  const repairButton = page.getByRole("button", { name: "Repair Driver app cache" });
  await expect(repairButton).toBeVisible();
  await expect(page.getByText(/Saved routes, photos, pending submissions, login state/u)).toBeVisible();

  await page.evaluate(async ({ activeCache, oldDriverCache, operatorCache, probeDb }) => {
    await navigator.serviceWorker.ready;
    const putProbeRecord = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(probeDb, 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => request.result.createObjectStore("records");
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("records", "readwrite");
        transaction.objectStore("records").put({ value: "preserved-offline-evidence" }, "probe");
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    await putProbeRecord();
    const active = await caches.open(activeCache);
    await active.put("/__mbbs_driver_offline_mode__", new Response("true"));
    await active.put("/unexpected-driver-entry", new Response("remove-me"));
    await (await caches.open(oldDriverCache)).put("/driver", new Response("old-driver-shell"));
    await (await caches.open(operatorCache)).put("/operator", new Response("preserve-operator-shell"));
  }, {
    activeCache: ACTIVE_CACHE,
    oldDriverCache: OLD_DRIVER_CACHE,
    operatorCache: OPERATOR_CACHE,
    probeDb: PROBE_DB
  });

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("saved route, photos, pending submissions, and login state");
    await dialog.accept();
  });
  await Promise.all([
    page.waitForURL(/\/driver\?cache-repair=/u),
    repairButton.click()
  ]);

  const preserved = await page.evaluate(async ({ activeCache, oldDriverCache, operatorCache, probeDb }) => {
    const readProbeRecord = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(probeDb, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("records", "readonly");
        const get = transaction.objectStore("records").get("probe");
        get.onsuccess = () => {
          db.close();
          resolve(get.result);
        };
        get.onerror = () => reject(get.error);
      };
    });
    const active = await caches.open(activeCache);
    return {
      cacheNames: await caches.keys(),
      driverPage: await (await active.match("/driver"))?.text(),
      unexpectedEntry: Boolean(await active.match("/unexpected-driver-entry")),
      offlineMode: await (await active.match("/__mbbs_driver_offline_mode__"))?.text(),
      operatorShell: await (await (await caches.open(operatorCache)).match("/operator"))?.text(),
      oldDriverCachePresent: (await caches.keys()).includes(oldDriverCache),
      loginToken: localStorage.getItem("mbbs.driver.token"),
      probeRecord: await readProbeRecord()
    };
  }, {
    activeCache: ACTIVE_CACHE,
    oldDriverCache: OLD_DRIVER_CACHE,
    operatorCache: OPERATOR_CACHE,
    probeDb: PROBE_DB
  });

  expect(preserved.cacheNames).toContain(ACTIVE_CACHE);
  expect(preserved.cacheNames).toContain(OPERATOR_CACHE);
  expect(preserved.oldDriverCachePresent).toBe(false);
  expect(preserved.driverPage).toContain("<!doctype html>");
  expect(preserved.unexpectedEntry).toBe(false);
  expect(preserved.offlineMode).toBe("true");
  expect(preserved.operatorShell).toBe("preserve-operator-shell");
  expect(preserved.loginToken).toBe("cache-repair-login-probe");
  expect(preserved.probeRecord).toEqual({ value: "preserved-offline-evidence" });
});

test("iPhone Driver hard reset clears origin storage and returns to a fresh online login", async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto("/driver");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.goto("/reset-driver");

  await page.evaluate(async ({ cacheName, databaseName }) => {
    localStorage.setItem("mbbs.driver.hardResetProbe", "remove-local");
    sessionStorage.setItem("mbbs.driver.hardResetProbe", "remove-session");
    document.cookie = "mbbs_driver_hard_reset_probe=remove-cookie; path=/; SameSite=Lax";
    await (await caches.open(cacheName)).put("/hard-reset-probe", new Response("remove-cache"));
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => request.result.createObjectStore("records");
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("records", "readwrite");
        transaction.objectStore("records").put("remove-database", "probe");
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, { cacheName: HARD_RESET_CACHE, databaseName: HARD_RESET_DB });

  const resetButton = page.getByRole("button", { name: "Erase site data and open fresh login" });
  await expect(resetButton).toBeDisabled();
  await page.getByLabel(/I confirm this device is online/u).check();
  await expect(resetButton).toBeEnabled();
  await Promise.all([
    page.waitForURL(/\/driver\?site-reset=/u),
    resetButton.click()
  ]);
  await expect(page.getByRole("heading", { name: "Driver Login" })).toBeVisible();
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/driver");
    return Boolean(registration?.active || registration?.installing || registration?.waiting);
  });

  const cleared = await page.evaluate(async ({ cacheName, databaseName }) => {
    const databases = typeof indexedDB.databases === "function"
      ? await indexedDB.databases()
      : [];
    const registration = await navigator.serviceWorker.getRegistration("/driver");
    return {
      localProbe: localStorage.getItem("mbbs.driver.hardResetProbe"),
      sessionProbe: sessionStorage.getItem("mbbs.driver.hardResetProbe"),
      cookie: document.cookie,
      staleCachePresent: (await caches.keys()).includes(cacheName),
      staleDatabasePresent: databases.some((database) => database.name === databaseName),
      workerScriptUrl: registration?.active?.scriptURL
        || registration?.installing?.scriptURL
        || registration?.waiting?.scriptURL
        || ""
    };
  }, { cacheName: HARD_RESET_CACHE, databaseName: HARD_RESET_DB });

  expect(cleared.localProbe).toBeNull();
  expect(cleared.sessionProbe).toBeNull();
  expect(cleared.cookie).not.toContain("mbbs_driver_hard_reset_probe");
  expect(cleared.staleCachePresent).toBe(false);
  expect(cleared.staleDatabasePresent).toBe(false);
  expect(cleared.workerScriptUrl).toContain("20260819-driver-route-readiness-v1");
});
