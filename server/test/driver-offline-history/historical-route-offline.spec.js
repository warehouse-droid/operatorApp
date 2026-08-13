import { expect, test } from "@playwright/test";

import history from "../fixtures/driver-offline-route-history.json" with { type: "json" };
import { materializeHistoricalRoute } from "../support/driver-offline-route-history.mjs";

const PROJECTS = ["chromium-mobile", "webkit-mobile"];
const SHARDS = [
  [0, 90],
  [90, 180],
  [180, 270],
  [270, 360],
  [360, 450],
  [450, 519]
];

async function loadRuntime(page) {
  await page.goto("/health");
  await page.addScriptTag({ url: "/driver-photo-hash.js" });
  await page.addScriptTag({ url: "/driver-offline-db.js" });
  await page.addScriptTag({ url: "/driver-offline-sync.js" });
}

async function installServerOracle(page) {
  await page.evaluate(() => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const state = {
      online: true,
      requestCount: 0,
      downloads: 0,
      uploads: new Map(),
      routes: new Map()
    };
    const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" }
    });
    const eventStatus = (route, stored) => {
      const priorApplied = stored.actionIndex === 0
        || route.eventsInOrder
          .slice(0, stored.actionIndex)
          .every((eventId) => route.applied.has(eventId));
      if (!priorApplied) {
        return "blocked";
      }
      if (stored.action.photoCount > 0) {
        const durable = (stored.payload.photos || []).every(({ photoId }) => route.receipts.has(photoId));
        return durable ? "applied" : "waiting_photos";
      }
      return "applied";
    };
    globalThis.__historyServer = {
      state,
      setOnline(online) { state.online = online; },
      registerRoute(manifest, actions) {
        if (state.routes.has(manifest.manifestId)) {
          throw new Error("Historical manifest was registered twice.");
        }
        state.routes.set(manifest.manifestId, {
          manifest,
          actions,
          downloadCount: 0,
          nextAction: 0,
          events: new Map(),
          eventsInOrder: [],
          receipts: new Set(),
          applied: new Set()
        });
      },
      routeSummary(manifestId) {
        const route = state.routes.get(manifestId);
        return {
          downloads: route?.downloadCount || 0,
          expected: route?.actions.length || 0,
          registered: route?.events.size || 0,
          applied: route?.applied.size || 0,
          receipts: route?.receipts.size || 0,
          requests: state.requestCount
        };
      }
    };
    globalThis.fetch = async (input, init = {}) => {
      const request = new Request(input, init);
      const url = new URL(request.url, location.origin);
      if (!url.pathname.startsWith("/api/driver/") && !url.pathname.startsWith("/history-upload/")) {
        return nativeFetch(input, init);
      }
      state.requestCount += 1;
      if (!state.online) {
        throw new TypeError("Historical route emulator is offline.");
      }

      if (url.pathname === "/api/driver/day-plan") {
        const route = [...state.routes.values()].find(({ manifest }) => manifest.id === url.searchParams.get("historyRoute"));
        if (!route) {
          return json({ error: "Unknown historical route" }, 404);
        }
        route.downloadCount += 1;
        state.downloads += 1;
        return json(route.manifest);
      }

      if (url.pathname === "/api/driver/offline-sync") {
        const body = await request.json();
        const route = state.routes.get(body.manifestId);
        if (!route) {
          return json({ error: "Unknown historical manifest" }, 404);
        }
        const photos = [];
        for (const receipt of body.photoReceipts || []) {
          if (!state.uploads.has(receipt.photoId)) {
            return json({ error: "Photo was not uploaded" }, 409);
          }
          route.receipts.add(receipt.photoId);
          photos.push({ ...receipt, status: "durably_received", durableReceipt: true });
        }
        const events = [];
        for (const event of body.events || []) {
          let stored = route.events.get(event.eventId);
          if (!stored) {
            const action = route.actions[route.nextAction];
            if (!action) {
              return json({ error: "Unexpected extra event" }, 409);
            }
            if (event.eventType !== action.eventType || event.jobId !== action.jobId) {
              return json({
                error: `Route order mismatch at ${route.nextAction}: expected ${action.eventType}/${action.jobId}, received ${event.eventType}/${event.jobId}`
              }, 409);
            }
            if ((event.photos || []).length !== action.photoCount) {
              return json({ error: `Photo descriptor mismatch for ${event.jobId}` }, 409);
            }
            stored = {
              payload: structuredClone(event),
              action,
              actionIndex: route.nextAction
            };
            route.events.set(event.eventId, stored);
            route.eventsInOrder.push(event.eventId);
            route.nextAction += 1;
          } else if (JSON.stringify(stored.payload) !== JSON.stringify(event)) {
            return json({ error: "Immutable event replay changed" }, 409);
          }
          const status = eventStatus(route, stored);
          if (status === "applied") {
            route.applied.add(event.eventId);
          }
          events.push({ eventId: event.eventId, status, appliedAt: new Date().toISOString() });
        }
        return json({
          events,
          photos,
          pendingCount: Math.max(0, route.actions.length - route.applied.size)
        });
      }

      if (url.pathname === "/api/driver/photo-upload-token") {
        const body = await request.json();
        return json({
          uploadUrl: `${location.origin}/history-upload/${body.photoId}`,
          token: "historical-upload-token"
        });
      }

      if (url.pathname.startsWith("/history-upload/")) {
        const photoId = url.pathname.split("/").at(-1);
        const bytes = await request.arrayBuffer();
        state.uploads.set(photoId, bytes.byteLength);
        return json({
          objectReference: `r2://driver/driver-stop-photo/2026/08/13/${photoId}/evidence.jpg`,
          byteSize: bytes.byteLength
        });
      }
      return json({});
    };
    globalThis.DriverOfflineSync.configure({
      getAuthToken: () => "historical-driver-token",
      onStatus: () => {},
      onUpdated: () => {}
    });
  });
}

async function downloadRoute(page, route) {
  const manifestId = await page.evaluate(async ({ source, materialized }) => {
    const profile = await globalThis.DriverOfflineDB.unlockPartition({
      login: `history-${source.id.toLowerCase()}`,
      name: "Anonymized historical driver"
    });
    const generatedManifestId = crypto.randomUUID();
    const manifest = {
      id: source.id,
      schemaVersion: 2,
      fingerprintVersion: 1,
      manifestId: generatedManifestId,
      planId: 900000 + materialized.routeNumber,
      planDate: source.date,
      planRevision: 1,
      generatedAt: new Date().toISOString(),
      expiresAt: "2099-12-31T23:59:59.000Z",
      offlineSyncGrant: "historical-offline-grant",
      complete: true,
      jobs: materialized.jobs
    };
    globalThis.__historyServer.registerRoute(manifest, materialized.actions);
    const response = await globalThis.fetch(`/api/driver/day-plan?historyRoute=${encodeURIComponent(source.id)}`);
    if (!response.ok) {
      throw new Error(`Historical route download failed: ${response.status}`);
    }
    const downloaded = await response.json();
    await globalThis.DriverOfflineDB.saveManifestAtomic(profile.partitionKey, downloaded);
    return { manifestId: generatedManifestId, partitionKey: profile.partitionKey, jobs: downloaded.jobs };
  }, { source: route.source, materialized: route.materialized });
  return manifestId;
}

async function queueWholeRouteOffline(page, runtime, route) {
  return page.evaluate(async ({ state, materialized }) => {
    const requestCountBefore = globalThis.__historyServer.state.requestCount;
    const queued = [];
    for (const job of state.jobs) {
      const common = {
        manifestId: state.manifestId,
        jobId: job.jobId,
        jobFingerprint: job.fingerprint,
        predecessorFingerprint: job.predecessorFingerprint,
        occurredAt: new Date().toISOString(),
        locationStatus: "not_checked_offline",
        details: { historicalRoute: materialized.id }
      };
      if (job.stopType === "truck_switch") {
        const event = await globalThis.DriverOfflineDB.queueEvent(state.partitionKey, {
          ...common,
          eventType: "truck_switched_physical",
          requiredPhotoCount: 0,
          photos: []
        });
        queued.push({ eventType: event.eventType, jobId: event.jobId, photoCount: event.photoIds.length });
        continue;
      }
      const started = await globalThis.DriverOfflineDB.queueEvent(state.partitionKey, {
        ...common,
        eventType: "job_started",
        requiredPhotoCount: 0,
        photos: []
      });
      queued.push({ eventType: started.eventType, jobId: started.jobId, photoCount: started.photoIds.length });

      const draftKey = `job:${state.manifestId}:${job.jobId}`;
      const photos = [];
      for (let ordinal = 0; ordinal < Number(job.requiredPhotos || 0); ordinal += 1) {
        const bytes = new TextEncoder().encode(`${materialized.id}:${job.jobId}:${ordinal}`);
        const blobBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        photos.push(await globalThis.DriverOfflineDB.saveDraftPhoto(state.partitionKey, draftKey, {
          photoId: crypto.randomUUID(),
          ordinal,
          recordType: "driver-stop-photo",
          mimeType: "image/jpeg",
          byteSize: bytes.byteLength,
          blobBytes,
          sha256: await globalThis.DriverPhotoHash.sha256(blobBytes)
        }));
      }
      const completed = await globalThis.DriverOfflineDB.queueEvent(state.partitionKey, {
        ...common,
        eventType: "job_completed",
        requiredPhotoCount: Number(job.requiredPhotos || 0),
        enforcePhotoCompletionLimit: Number(job.requiredPhotos || 0) > 0,
        photos
      });
      queued.push({ eventType: completed.eventType, jobId: completed.jobId, photoCount: completed.photoIds.length });
    }
    return {
      queued,
      networkRequests: globalThis.__historyServer.state.requestCount - requestCountBefore,
      pendingEvents: (await globalThis.DriverOfflineDB.getPendingEvents(state.partitionKey)).length,
      pendingPhotos: (await globalThis.DriverOfflineDB.getPendingPhotos(state.partitionKey)).length
    };
  }, { state: runtime, materialized: route.materialized });
}

async function drainRoute(page, runtime) {
  return page.evaluate(async (state) => {
    const result = await globalThis.DriverOfflineSync.syncPartition(state.partitionKey);
    const pendingEvents = await globalThis.DriverOfflineDB.getPendingEvents(state.partitionKey);
    const pendingPhotos = await globalThis.DriverOfflineDB.getPendingPhotos(state.partitionKey);
    return {
      result,
      pendingEvents: pendingEvents.length,
      pendingPhotos: pendingPhotos.length,
      server: globalThis.__historyServer.routeSummary(state.manifestId)
    };
  }, runtime);
}

for (const project of PROJECTS) {
  for (const [from, to] of SHARDS) {
    test(`historical routes ${String(from + 1).padStart(3, "0")}-${String(to).padStart(3, "0")} complete wholly offline then drain @${project}`, async ({ page, context }, testInfo) => {
      await loadRuntime(page);
      await installServerOracle(page);
      const metrics = { routes: 0, jobs: 0, actions: 0, photos: 0, directPickups: 0 };
      for (const source of history.routes.slice(from, to)) {
        const materialized = materializeHistoricalRoute(source);
        const route = { source, materialized };
        const runtime = await downloadRoute(page, route);
        await page.evaluate(() => globalThis.__historyServer.setOnline(false));
        await context.setOffline(true);
        const offline = await queueWholeRouteOffline(page, runtime, route);
        expect(offline.networkRequests, `${source.id} must not call the network during route execution`).toBe(0);
        expect(offline.queued).toEqual(materialized.actions);
        expect(offline.pendingEvents).toBe(materialized.actions.length);
        expect(offline.pendingPhotos).toBe(materialized.actions.reduce((sum, action) => sum + action.photoCount, 0));

        await context.setOffline(false);
        await page.evaluate(() => globalThis.__historyServer.setOnline(true));
        const drained = await drainRoute(page, runtime);
        expect(drained.result.ok, `${source.id} did not converge`).toBe(true);
        expect(drained.result.reviewRequired, `${source.id} entered review`).toBe(false);
        expect(drained.pendingEvents, `${source.id} retained pending events`).toBe(0);
        expect(drained.pendingPhotos, `${source.id} retained pending photos`).toBe(0);
        expect(drained.server).toMatchObject({
          downloads: 1,
          expected: materialized.actions.length,
          registered: materialized.actions.length,
          applied: materialized.actions.length,
          receipts: materialized.actions.reduce((sum, action) => sum + action.photoCount, 0)
        });

        metrics.routes += 1;
        metrics.jobs += materialized.jobs.length;
        metrics.actions += materialized.actions.length;
        metrics.photos += materialized.actions.reduce((sum, action) => sum + action.photoCount, 0);
        metrics.directPickups += materialized.jobs.filter((job) => job.dependencyPickupManifests.length).length;
      }
      await testInfo.attach("historical-route-summary.json", {
        body: Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`),
        contentType: "application/json"
      });
      expect(metrics.routes).toBe(to - from);
    });
  }
}
