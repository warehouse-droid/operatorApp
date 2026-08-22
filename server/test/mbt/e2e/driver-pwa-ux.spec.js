import { readFile } from "node:fs/promises";

import { devices } from "@playwright/test";

import { expect, test } from "./mbt-e2e-test.js";

/* global document, getComputedStyle, localStorage, navigator, requestAnimationFrame, window */

const FRONTEND_ORIGIN = "http://127.0.0.1:4173";
const DRIVER_VERSION = "2026.08.12.3";
const IPHONE_GENERATIONS = ["13", "14", "15", "16", "17"];
const torontoDateParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).formatToParts(new Date()).map((part) => [part.type, part.value]));
const CURRENT_TORONTO_DATE = `${torontoDateParts.year}-${torontoDateParts.month}-${torontoDateParts.day}`;
const iphoneDeviceNames = Object.keys(devices).filter((name) => (
  new RegExp(`^iPhone (?:${IPHONE_GENERATIONS.join("|")})(?:\\b|e\\b)`, "u").test(name)
));

const frontendAssets = new Map(await Promise.all([
  ["/driver", "driver.html", "text/html"],
  ["/driver.css", "driver.css", "text/css"],
  ["/i18n.css", "i18n.css", "text/css"],
  ["/i18n.js", "i18n.js", "text/javascript"],
  ["/driver-offline-db.js", "driver-offline-db.js", "text/javascript"],
  ["/driver-photo-hash.js", "driver-photo-hash.js", "text/javascript"],
  ["/driver-offline-photos.js", "driver-offline-photos.js", "text/javascript"],
  ["/driver-offline-sync.js", "driver-offline-sync.js", "text/javascript"],
  ["/driver-bin-ui.js", "driver-bin-ui.js", "text/javascript"],
  ["/driver-location-override.js", "driver-location-override.js", "text/javascript"],
  ["/driver.js", "driver.js", "text/javascript"]
].map(async ([path, filename, contentType]) => [
  path,
  {
    body: await readFile(new URL(`../../../public/${filename}`, import.meta.url)),
    contentType
  }
])));

const historyRecords = Array.from({ length: 24 }, (_, index) => ({
  id: `history-${index + 1}`,
  type: "stop",
  title: `Delivery stop ${index + 1}`,
  reference: `SOB${String(117700 + index)}`,
  truckPlate: "CE94489",
  planDate: "2026-08-19",
  status: "completed",
  createdAt: new Date(Date.UTC(2026, 7, 19, 12, index)).toISOString(),
  photos: [],
  details: { loadName: `Load ${1 + (index % 4)}` }
}));

const stickyActionJob = {
  jobId: "sticky-action-job-1",
  planDate: CURRENT_TORONTO_DATE,
  driverLogin: "responsive.driver",
  driverName: "Responsive Driver",
  truckId: "truck-1",
  truckPlate: "CE94489",
  loadId: "load-1",
  loadName: "Load 1",
  stopId: "sticky-action-stop-1",
  stopType: "pickup",
  status: "pending",
  location: "2967",
  address: "2967 Kennedy Road, Toronto, ON",
  requiredPhotos: 0,
  orders: Array.from({ length: 4 }, (_orderValue, orderIndex) => ({
    orderRef: `PO-STICKY-${orderIndex + 1}`,
    items: Array.from({ length: 8 }, (_itemValue, itemIndex) => ({
      itemName: `Long item ${orderIndex + 1}-${itemIndex + 1}`,
      description: "Long content used to verify that no scrolled order text is visible beneath the Driver action bar.",
      units: [{ value: 12 + itemIndex, unit: "PALLET" }]
    }))
  })),
  fingerprint: "sticky-action-fingerprint-1",
  contentFingerprint: "sticky-action-content-1"
};

const fulfillJson = (route, payload) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(payload)
});

const installDriverFrontend = async (page) => {
  await page.addInitScript(() => {
    localStorage.setItem("mbbs.driver.token", "responsive-frontend-test-token");
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true
    });
    class ResponsiveTestEventSource {
      addEventListener() {}

      close() {}
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: ResponsiveTestEventSource
    });
  });

  await page.route(`${FRONTEND_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/driver/client-version") {
      return fulfillJson(route, {
        currentVersion: DRIVER_VERSION,
        minimumVersion: DRIVER_VERSION,
        isCurrent: true,
        offlineEnabled: false,
        offlineModeRevision: "responsive-test"
      });
    }
    if (url.pathname === "/api/driver/me") {
      return fulfillJson(route, {
        driver: {
          id: "responsive-driver",
          login: "responsive.driver",
          name: "Very Long Driver Name Used To Verify Responsive Personal History",
          samsaraEnabled: false
        }
      });
    }
    if (url.pathname === "/api/driver/next-job") {
      return fulfillJson(route, {
        job: null,
        rest: null,
        restSummary: null,
        state: {
          planDate: CURRENT_TORONTO_DATE,
          samsaraEnabled: false,
          allJobsComplete: false
        }
      });
    }
    if (url.pathname === "/api/driver/history") {
      return fulfillJson(route, { records: historyRecords });
    }
    if (url.pathname.startsWith("/api/")) {
      return fulfillJson(route, {});
    }

    const asset = frontendAssets.get(url.pathname);
    if (asset) {
      return route.fulfill({
        status: 200,
        contentType: asset.contentType,
        body: asset.body
      });
    }
    return route.fulfill({ status: 404, body: "Not found" });
  });
};

const assertHistoryBackIsUsable = async (page, { profileName, textScale }) => {
  await page.goto(`${FRONTEND_ORIGIN}/driver`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-action="open-history"]')).toBeVisible();
  await page.locator("#driverApp").evaluate((element) => {
    element.style.setProperty("--driver-safe-top", "24px");
    element.style.setProperty("--driver-safe-bottom", "34px");
  });
  await page.locator("html").evaluate((element, scale) => {
    element.style.fontSize = `${scale}%`;
  }, textScale);
  await page.locator('[data-action="open-history"]').click();
  await expect(page.locator(".history-panel")).toBeVisible();

  const scrollPosition = await page.locator(".driver-content").evaluate(async (element) => {
    element.scrollTop = element.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return element.scrollTop;
  });
  expect(scrollPosition, `${profileName} at ${textScale}% text should exercise the scrolled header`).toBeGreaterThan(0);

  const back = page.locator('[data-action="back-job"]');
  await expect(back, `${profileName} at ${textScale}% text`).toBeVisible();

  const layout = await back.evaluate((element) => {
    const rectangle = (target) => {
      const value = target.getBoundingClientRect();
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        width: value.width,
        height: value.height
      };
    };
    const intersects = (left, right) => (
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5
      && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5
    );
    const elementLabel = (target) => {
      if (!target) {
        return "none";
      }
      return target.className || target.tagName || "none";
    };
    const overlapLabels = (target, targetBounds, candidates) => candidates.flatMap(([label, selector]) => (
      [...document.querySelectorAll(selector)]
        .filter((candidate) => candidate !== target && candidate.getClientRects().length > 0)
        .filter((candidate) => intersects(targetBounds, rectangle(candidate)))
        .map(() => label)
    ));
    const occlusionSamples = (target) => {
      const targetBounds = target.getBoundingClientRect();
      const samples = [];
      for (const horizontal of [0.08, 0.5, 0.92]) {
        for (const vertical of [0.08, 0.5, 0.92]) {
          const x = targetBounds.left + (targetBounds.width * horizontal);
          const y = targetBounds.top + (targetBounds.height * vertical);
          const hit = document.elementFromPoint(x, y);
          if (hit !== target && !target.contains(hit)) {
            samples.push({ x, y, hit: elementLabel(hit) });
          }
        }
      }
      return samples;
    };
    const geometryEntry = ([name, target]) => {
      if (!target) {
        return [name, null];
      }
      const style = getComputedStyle(target);
      return [name, {
        rectangle: rectangle(target),
        clientWidth: target.clientWidth,
        scrollWidth: target.scrollWidth,
        width: style.width,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth,
        gridTemplateColumns: style.gridTemplateColumns,
        overflowX: style.overflowX
      }];
    };
    const overflowWidth = (target) => {
      if (!target) {
        return 0;
      }
      return target.scrollWidth - target.clientWidth;
    };
    const clippingSnapshot = (topChrome, bottomChrome) => {
      let topHit = null;
      if (topChrome) {
        const chromeBounds = rectangle(topChrome);
        topHit = document.elementFromPoint(
          window.innerWidth / 2,
          chromeBounds.top + Math.min(8, chromeBounds.height / 2)
        );
      }
      const bottomHit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 8);
      const topProtected = Boolean(topChrome && topChrome.contains(topHit))
        || Boolean(topHit && topHit.closest(".driver-language, .driver-logout-button"));
      return {
        topHit: elementLabel(topHit),
        topProtected,
        bottomHit: elementLabel(bottomHit),
        bottomProtected: Boolean(bottomChrome && bottomChrome.contains(bottomHit)),
        bottomContainsHistoryContent: Boolean(bottomHit && bottomHit.closest(".history-panel"))
      };
    };
    const candidateSelectors = [
      ["language switch", ".driver-language"],
      ["logout", ".driver-logout-button"],
      ["driver name", ".history-head p"],
      ["history heading", ".history-head h2"],
      ["history date", "#driverHistoryDate"],
      ["history refresh", '[data-action="refresh-history"]']
    ];
    const backBounds = rectangle(element);
    const content = document.querySelector(".driver-content");
    const topChrome = document.querySelector(".driver-top-chrome");
    const bottomChrome = document.querySelector(".driver-bottom-chrome");
    const geometry = Object.fromEntries([
      ["html", document.documentElement],
      ["body", document.body],
      ["app", document.getElementById("driverApp")],
      ["shell", document.querySelector(".driver-shell")],
      ["topChrome", topChrome],
      ["bottomChrome", bottomChrome],
      ["content", content],
      ["panel", document.querySelector(".history-panel")],
      ["controls", document.querySelector(".history-controls")],
      ["head", document.querySelector(".history-head")],
      ["filter", document.querySelector(".history-filter")],
      ["list", document.querySelector(".history-list")],
      ["record", document.querySelector(".history-record")]
    ].map(geometryEntry));
    return {
      backBounds,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      horizontalOverflow: {
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        content: overflowWidth(content)
      },
      overlaps: overlapLabels(element, backBounds, candidateSelectors),
      occludedSamples: occlusionSamples(element),
      viewportClipping: clippingSnapshot(topChrome, bottomChrome),
      geometry
    };
  });

  const geometryMessage = `${profileName} at ${textScale}% geometry: ${JSON.stringify(layout.geometry)}`;
  expect(layout.backBounds.left, `${profileName} at ${textScale}% text left edge`).toBeGreaterThanOrEqual(0);
  expect(layout.backBounds.right, geometryMessage).toBeLessThanOrEqual(layout.viewport.width);
  expect(layout.backBounds.top, `${profileName} at ${textScale}% text top edge`).toBeGreaterThanOrEqual(0);
  expect(layout.backBounds.bottom, `${profileName} at ${textScale}% text bottom edge`).toBeLessThanOrEqual(layout.viewport.height);
  expect(layout.horizontalOverflow.document, `${profileName} at ${textScale}% text document overflow`).toBeLessThanOrEqual(1);
  expect(layout.horizontalOverflow.content, geometryMessage).toBeLessThanOrEqual(1);
  expect(layout.overlaps, `${profileName} at ${textScale}% text element overlaps`).toEqual([]);
  expect(layout.occludedSamples, `${profileName} at ${textScale}% text covered hit area`).toEqual([]);
  expect(layout.viewportClipping.topProtected, `${profileName} at ${textScale}% top chrome clipping: ${JSON.stringify(layout.viewportClipping)}`).toBe(true);
  expect(layout.viewportClipping.bottomProtected, `${profileName} at ${textScale}% bottom chrome clipping: ${JSON.stringify(layout.viewportClipping)}`).toBe(true);
  expect(layout.viewportClipping.bottomContainsHistoryContent, `${profileName} at ${textScale}% bottom safe-area clipping: ${JSON.stringify(layout.viewportClipping)}`).toBe(false);

  await back.click();
  await expect(page.locator(".history-panel")).toHaveCount(0);
  await expect(page.locator("[data-driver-no-job]")).toBeVisible();
};

const assertJobActionsSealBottom = async (page, { profileName }) => {
  await page.route(`${FRONTEND_ORIGIN}/api/driver/next-job**`, (route) => fulfillJson(route, {
    job: stickyActionJob,
    rest: null,
    restSummary: null,
    state: {
      planDate: CURRENT_TORONTO_DATE,
      samsaraEnabled: false,
      allJobsComplete: false
    }
  }));
  await page.goto(`${FRONTEND_ORIGIN}/driver`, { waitUntil: "domcontentloaded" });
  await page.locator("#driverApp").evaluate((element) => {
    element.style.setProperty("--driver-safe-top", "24px");
    element.style.setProperty("--driver-safe-bottom", "34px");
  });

  const actions = page.locator(".job-actions");
  const content = page.locator(".driver-content");
  await expect(actions, `${profileName} Driver actions`).toBeVisible();
  await expect(page.locator(".order-card"), `${profileName} long-order fixture`).toHaveCount(4);
  await expect.poll(
    () => content.evaluate(async (element) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return element.scrollHeight - element.clientHeight;
    }),
    { message: `${profileName} should exercise a long scrolling job` }
  ).toBeGreaterThan(100);

  for (const fraction of [0, 0.5, 1]) {
    await content.evaluate(async (element, position) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * position;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, fraction);
    const layout = await actions.evaluate((element) => {
      const actionBounds = element.getBoundingClientRect();
      const bottomChrome = document.querySelector(".driver-bottom-chrome");
      const chromeBounds = bottomChrome?.getBoundingClientRect();
      const sampleX = actionBounds.left + (actionBounds.width / 2);
      const sampleY = Math.min(window.innerHeight - 1, Number(chromeBounds?.top || window.innerHeight) - 1);
      const hit = document.elementFromPoint(sampleX, sampleY);
      const background = getComputedStyle(element).backgroundColor;
      return {
        actionBottom: actionBounds.bottom,
        chromeTop: chromeBounds?.top ?? window.innerHeight,
        gap: (chromeBounds?.top ?? window.innerHeight) - actionBounds.bottom,
        sealsPixelAboveChrome: Boolean(hit && element.contains(hit)),
        background
      };
    });
    expect(Math.abs(layout.gap), `${profileName} at scroll ${fraction}: ${JSON.stringify(layout)}`).toBeLessThanOrEqual(1);
    expect(layout.sealsPixelAboveChrome, `${profileName} at scroll ${fraction}: ${JSON.stringify(layout)}`).toBe(true);
    expect(layout.background, `${profileName} opaque action background`).toBe("rgb(255, 255, 255)");
  }
};

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await installDriverFrontend(page);
});

test("one frontend location override survives a same-stop server refresh", async ({ page }) => {
  const job = {
    jobId: "location-override-job-1",
    planDate: CURRENT_TORONTO_DATE,
    driverLogin: "responsive.driver",
    driverName: "Responsive Driver",
    truckId: "truck-1",
    truckPlate: "CE94489",
    loadId: "load-1",
    loadName: "Load 1",
    stopId: "stop-1",
    stopType: "pickup",
    status: "in_progress",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    location: "2967",
    address: "2967 Kennedy Road, Toronto, ON",
    requiredPhotos: 2,
    orders: [],
    fingerprint: "location-override-fingerprint-1",
    contentFingerprint: "location-override-content-1"
  };
  await page.route(`${FRONTEND_ORIGIN}/api/driver/next-job**`, (route) => fulfillJson(route, {
    job,
    rest: null,
    restSummary: null,
    state: {
      planDate: CURRENT_TORONTO_DATE,
      samsaraEnabled: false,
      allJobsComplete: false
    }
  }));

  await page.goto(`${FRONTEND_ORIGIN}/driver`, { waitUntil: "domcontentloaded" });
  const override = page.locator('[data-action="override-location"]');
  await expect(override).toBeVisible();
  await override.click();

  await expect(page.locator(".location-check.warning_overridden")).toContainText("Location override accepted");
  await expect(page.locator('[data-action="show-photo"]')).toBeEnabled();
  await expect(page.locator('[data-action="override-location"]')).toHaveCount(0);
  await expect(page.locator(".photo-modal")).toHaveCount(0);
  await page.waitForTimeout(1_200);
  await expect(page.locator(".photo-modal")).toHaveCount(0);

  await page.locator('[data-action="show-photo"]').click();
  await expect(page.locator(".photo-modal")).toBeVisible();
  await page.locator('[data-action="close-photo"]').click();
  await expect(page.locator(".photo-modal")).toHaveCount(0);

  await page.locator('[data-action="refresh"]').click();
  await expect(page.locator(".location-check.warning_overridden")).toContainText("Location override accepted");
  await expect(page.locator('[data-action="show-photo"]')).toBeEnabled();
  await expect(page.locator('[data-action="override-location"]')).toHaveCount(0);
  await expect(page.locator(".photo-modal")).toHaveCount(0);
});

test("an ended rest stays closed when Refresh receives the same stale active rest", async ({ page }) => {
  const job = {
    ...stickyActionJob,
    jobId: "rest-refresh-job-1",
    stopId: "rest-refresh-stop-1",
    orders: []
  };
  const activeRestRecord = {
    id: "rest-refresh-1",
    restId: "rest-refresh-1",
    status: "active",
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    planDate: CURRENT_TORONTO_DATE,
    nextJobId: job.jobId
  };
  const state = {
    planDate: CURRENT_TORONTO_DATE,
    samsaraEnabled: false,
    allJobsComplete: false
  };
  await page.route(`${FRONTEND_ORIGIN}/api/driver/next-job**`, (route) => fulfillJson(route, {
    job,
    rest: activeRestRecord,
    restSummary: {
      planDate: CURRENT_TORONTO_DATE,
      sessionCount: 1,
      completedSeconds: 0
    },
    state
  }));
  await page.route(`${FRONTEND_ORIGIN}/api/driver/rest/end`, (route) => fulfillJson(route, {
    job,
    rest: {
      ...activeRestRecord,
      status: "complete",
      endedAt: new Date().toISOString()
    },
    restSummary: {
      planDate: CURRENT_TORONTO_DATE,
      sessionCount: 1,
      completedSeconds: 300
    }
  }));

  await page.goto(`${FRONTEND_ORIGIN}/driver`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".rest-modal")).toBeVisible();
  await page.locator('[data-action="end-rest"]').click();
  await expect(page.locator(".rest-modal")).toHaveCount(0);

  await page.locator('[data-action="refresh"]').click();
  await expect(page.locator(".rest-modal")).toHaveCount(0);
  await page.waitForTimeout(1_200);
  await expect(page.locator(".rest-modal")).toHaveCount(0);
  await expect(page.locator('[data-action="start-rest"]')).toBeVisible();
});

test("the frontend language switch renders translated delivery instructions in both languages", async ({ page }) => {
  const englishAutomatic = "Leave pallets beside door 2. Call 416-555-0100.";
  const englishAdditional = "Do not block the emergency exit.";
  const chineseAutomatic = "请将托盘放在2号门旁。请致电416-555-0100。";
  const chineseAdditional = "请勿阻塞紧急出口。";
  const baseOrder = {
    orderId: "translation-order-1",
    orderRef: "SOA06329",
    customer: "Responsive Customer",
    automaticText: englishAutomatic,
    additionalText: englishAdditional,
    phones: [],
    media: []
  };
  const instructionsFor = (language) => ({
    revision: 1,
    orders: [{
      ...baseOrder,
      localized: {
        language,
        automaticText: language === "zh-CN" ? chineseAutomatic : englishAutomatic,
        additionalText: language === "zh-CN" ? chineseAdditional : englishAdditional,
        automaticStatus: "translated",
        additionalStatus: "translated"
      }
    }]
  });
  const job = {
    jobId: "translation-job-1",
    planDate: CURRENT_TORONTO_DATE,
    driverLogin: "responsive.driver",
    driverName: "Responsive Driver",
    truckId: "truck-1",
    truckPlate: "CE94489",
    loadId: "load-1",
    loadName: "Load 1",
    stopId: "translation-stop-1",
    stopType: "dropoff",
    status: "pending",
    location: "Customer Site",
    address: "37 Sunmount Road, Toronto, ON",
    requiredPhotos: 0,
    orders: [],
    deliveryInstructions: instructionsFor("en"),
    fingerprint: "translation-fingerprint-1",
    contentFingerprint: "translation-content-1"
  };
  const requestedLanguages = [];
  await page.route(`${FRONTEND_ORIGIN}/api/driver/next-job**`, (route) => fulfillJson(route, {
    job,
    rest: null,
    restSummary: null,
    state: {
      planDate: CURRENT_TORONTO_DATE,
      samsaraEnabled: false,
      allJobsComplete: false
    }
  }));
  await page.route(`${FRONTEND_ORIGIN}/api/driver/jobs/translation-job-1/delivery-instructions**`, (route) => {
    const language = new URL(route.request().url()).searchParams.get("language") === "zh-CN" ? "zh-CN" : "en";
    requestedLanguages.push(language);
    return fulfillJson(route, { deliveryInstructions: instructionsFor(language) });
  });

  await page.goto(`${FRONTEND_ORIGIN}/driver`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".driver-delivery-instruction-text").first()).toHaveText(englishAutomatic);

  await page.locator('[data-language="zh-CN"]').click();
  await expect(page.locator(".driver-delivery-instruction-text").first()).toHaveText(chineseAutomatic);
  await expect(page.locator(".driver-additional-instruction .driver-delivery-instruction-text")).toHaveText(chineseAdditional);
  expect(requestedLanguages).toContain("zh-CN");

  await page.locator('[data-language="en"]').click();
  await expect(page.locator(".driver-delivery-instruction-text").first()).toHaveText(englishAutomatic);
  await expect(page.locator(".driver-additional-instruction .driver-delivery-instruction-text")).toHaveText(englishAdditional);
});

test("the responsive matrix contains every iPhone generation from 13 through 17", () => {
  for (const generation of IPHONE_GENERATIONS) {
    expect(
      iphoneDeviceNames.some((name) => name.startsWith(`iPhone ${generation}`)),
      `missing iPhone ${generation} Playwright profiles`
    ).toBe(true);
  }
});

for (const deviceName of iphoneDeviceNames) {
  test.describe(deviceName, () => {
    const device = devices[deviceName];
    test.use({
      userAgent: device.userAgent,
      viewport: device.viewport,
      screen: device.screen,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch
    });

    test("the real Personal History frontend has a visible, non-overlapping Back control", async ({ page }) => {
      for (const textScale of [100, 200]) {
        await assertHistoryBackIsUsable(page, { profileName: deviceName, textScale });
      }
    });

    test("the real Driver action bar seals the bottom edge", async ({ page }) => {
      await assertJobActionsSealBottom(page, { profileName: deviceName });
    });
  });
}

test("the real Personal History frontend remains usable at compact breakpoints", async ({ page }) => {
  for (const viewport of [
    { name: "compact 320 x 568", width: 320, height: 568 },
    { name: "compact 360 x 640", width: 360, height: 640 }
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const textScale of [100, 200]) {
      await assertHistoryBackIsUsable(page, { profileName: viewport.name, textScale });
    }
  }
});

test("Personal History Back renders the cached work screen before its server refresh finishes", async ({ page }) => {
  await page.goto(`${FRONTEND_ORIGIN}/driver`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-action="open-history"]').click();
  await expect(page.locator(".history-panel")).toBeVisible();

  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route(`${FRONTEND_ORIGIN}/api/driver/next-job**`, async (route) => {
    await refreshGate;
    return fulfillJson(route, {
      job: null,
      rest: null,
      restSummary: null,
      state: {
        planDate: CURRENT_TORONTO_DATE,
        samsaraEnabled: false,
        allJobsComplete: false
      }
    });
  });

  await page.locator('[data-action="back-job"]').click();
  await expect(page.locator(".history-panel")).toHaveCount(0, { timeout: 250 });
  await expect(page.locator("[data-driver-no-job]")).toBeVisible({ timeout: 250 });

  releaseRefresh();
  await expect(page.locator("[data-driver-no-job]")).toBeVisible();
});
