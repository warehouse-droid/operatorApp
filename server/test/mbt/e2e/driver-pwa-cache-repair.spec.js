/* global caches, indexedDB, localStorage, navigator, Response */
import { expect, test } from "./mbt-e2e-test.js";

const ACTIVE_CACHE = "mbbs-driver-shell-v27";
const OLD_DRIVER_CACHE = "mbbs-driver-shell-v26";
const OPERATOR_CACHE = "mbbs-yard-operator-cache-repair-probe";
const PROBE_DB = "mbbs-driver-cache-repair-probe";

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
