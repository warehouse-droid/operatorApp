// NetSuite order webhook receiver. It runs in its own container (webhook-receiver, 127.0.0.1:3001), and
// Cloudflare routes test.mbbsoperation.com/api/webhooks/netsuite/order to it, so app releases and
// restarts no longer lose NetSuite order webhooks. Like the app's route (kept as a fallback), it only checks
// the secret and saves the payload to netsuite_order_webhook_inbox; the webhook-worker container
// processes the inbox and the app shows the result. It must not import server.js: it has to start in
// about a second and has no reason to change when the app changes.
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { writeAudit } from "./auth-repository.js";
import { config } from "./config.js";
import { closeDb, query } from "./db.js";
import { applyOriginKeepAlive } from "./http-keep-alive.js";
import { isNetSuiteMirrorConsumer } from "./netsuite-mirror-repository.js";
import { enqueueNetSuiteOrderWebhook } from "./netsuite-order-webhook-queue-repository.js";
import { closeSystemAudit, installSystemAuditConsoleCapture, installSystemAuditProcessHooks } from "./system-audit.js";

export const NETSUITE_ORDER_WEBHOOK_PATH = "/api/webhooks/netsuite/order";

/** The same answers as the app's POST /api/webhooks/netsuite/order. */
export function createNetSuiteOrderWebhookReceiver({
  enqueue = enqueueNetSuiteOrderWebhook,
  audit = writeAudit,
  webhookSecret = () => config.netsuite.webhookSecret,
  mirrorConsumer = isNetSuiteMirrorConsumer,
  ping = () => query("SELECT 1"),
  logger = console
} = {}) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", async (req, res) => {
    try {
      await ping();
      res.json({ ok: true, service: "webhook-receiver" });
    } catch {
      res.status(503).json({ ok: false, error: "Database unavailable." });
    }
  });

  app.post(NETSUITE_ORDER_WEBHOOK_PATH, express.json({
    limit: "25mb",
    verify(req, res, buffer) {
      req.rawBody = buffer.toString("utf8");
    }
  }), async (req, res, next) => {
    try {
      if (mirrorConsumer()) return res.status(403).json({ error: "NetSuite webhooks are disabled on the mirror consumer." });
      const expectedSecret = webhookSecret();
      if (!expectedSecret) return res.status(503).json({ error: "NETSUITE_WEBHOOK_SECRET is not configured on the server." });
      const providedSecret = req.get("x-mbbs-webhook-secret") || req.body?.secret || "";
      const providedBuffer = Buffer.from(String(providedSecret));
      const expectedBuffer = Buffer.from(String(expectedSecret));
      if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
        return res.status(401).json({ error: "Invalid webhook secret." });
      }
      let queued;
      try {
        queued = await enqueue({
          payload: req.body || {},
          rawBody: req.rawBody || ""
        });
      } catch (error) {
        if (error instanceof TypeError && !error.status) error.status = 400;
        throw error;
      }
      res.status(202).json({
        accepted: true,
        queued: queued.status === "queued",
        duplicate: queued.duplicate === true,
        superseded: queued.superseded === true,
        coalesced: Number(queued.coalesced || 0),
        queueId: queued.id
      });
    } catch (error) {
      await audit({
        actorType: "system",
        source: "netsuite-webhook",
        action: "netsuite.webhook.failed",
        details: {
          error: error.message,
          netsuiteOrderId: req.body?.id || null,
          tranid: req.body?.tranid || "",
          recordType: req.body?.recordType || req.body?.type || req.body?.orderType || "",
          eventType: req.body?.eventType || "",
          receiver: "webhook-receiver"
        }
      }).catch(() => {});
      next(error);
    }
  });

  app.use((req, res) => res.status(404).json({ error: "Not found." }));
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    logger.error(error);
    res.status(error.status || 500).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  });
  return app;
}

export async function startNetSuiteOrderWebhookReceiver({ port = config.port, receiver = createNetSuiteOrderWebhookReceiver() } = {}) {
  const server = applyOriginKeepAlive(receiver.listen(port));
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  installSystemAuditProcessHooks({
    processName: "webhook-receiver",
    crashFile: new URL("../data/system-audit-crash-webhook-receiver.ndjson", import.meta.url)
  });
  installSystemAuditConsoleCapture({ processName: "webhook-receiver" });
  const server = await startNetSuiteOrderWebhookReceiver();
  console.log(`NetSuite order webhook receiver listening on port ${server.address().port}.`);
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      // Finish webhooks already being saved, then exit; Docker allows 10 s.
      setTimeout(() => process.exit(0), 8000).unref();
      server.close(async () => {
        await closeSystemAudit().catch(() => {});
        await closeDb().catch(() => {});
        process.exit(0);
      });
      server.closeIdleConnections();
    });
  }
}
