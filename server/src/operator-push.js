// @ts-check
// Operator Web Push: urgent Delivery Prep alerts for Operator devices that are closed or asleep.
//
// An open Operator page polls GET /api/delivery/notifications and alerts when an item appears
// already planned or its notification key changes (public/operator.js changedDeliveryNotificationItems).
// This module makes the same decision on the server, per yard, and sends a Web Push to the devices
// subscribed at that yard. Keys and the notification tag match the page, so a device that is also
// showing the page gets one notification, not two.
import crypto from "node:crypto";
import webpush from "web-push";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { getDeliveryPrepNotifications } from "./delivery-repository.js";
import { OPERATOR_YARD_LOCATION_IDS, assertOperatorYard, operatorYardLocationIds } from "./operator-yard-access.js";

const OPERATOR_ROLES = ["admin", "operator", "yard_manager"];
const LOCK_KEY = "operator-delivery-push";
const PUSH_TTL_SECONDS = 3600;
const TEST_INTERVAL_MS = 30_000;
const TEXT = {
  en: { one: "New urgent delivery order", many: "new urgent delivery orders", salesOrder: "Sales Order",
    transferOrder: "Transfer Order", parkingSpot: "Parking spot", testTitle: "Background alerts are on",
    testBody: "Urgent Delivery Prep alerts will reach this device when MBBS Yard is closed." },
  "zh-CN": { one: "新的紧急配送订单", many: "个新的紧急配送订单", salesOrder: "销售订单",
    transferOrder: "调拨订单", parkingSpot: "停车位", testTitle: "后台提醒已开启",
    testBody: "MBBS Yard 关闭时，紧急配送准备提醒也会发送到此设备。" }
};

/** Shared with Driver and Repair push (config.driverRoutePush); read on every call so a reload applies. */
export function operatorPushSettings() {
  const settings = config.driverRoutePush || {};
  const publicKey = String(settings.vapidPublicKey || "").trim();
  const privateKey = String(settings.vapidPrivateKey || "").trim();
  const subject = String(settings.vapidSubject || "").trim();
  return { publicKey, privateKey, subject, enabled: Boolean(publicKey && privateKey && subject) };
}

export function operatorPushPublicConfiguration() {
  const settings = operatorPushSettings();
  return { enabled: settings.enabled, publicKey: settings.enabled ? settings.publicKey : "" };
}

/** @param {any} item Same as deliveryNotificationBaseKey in public/operator.js. */
export function deliveryNotificationBaseKey(item) {
  return `${item?.type || "order"}:${item?.orderId || item?.tranid || ""}`;
}

/** @param {any} item Same as deliveryNotificationKey in public/operator.js. */
export function deliveryNotificationKey(item) {
  const base = deliveryNotificationBaseKey(item);
  const reason = item?.dispatchPlanned
    ? `planned:${item?.dispatchPlanDate || ""}:${item?.dispatchPlannedAt || ""}:${item?.truck || ""}:${item?.load || ""}:${item?.parkingSpot || ""}`
    : `due:${item?.expectedDeliveryDate || item?.dispatchPlanDate || ""}`;
  return `${base}:${reason}`;
}

/**
 * Items an open Operator page would alert for (changedDeliveryNotificationItems).
 * @param {any[]} items @param {Map<string,string>} previous @param {boolean} seeded
 */
export function changedDeliveryItems(items, previous, seeded) {
  const changed = items.filter((item) => {
    const base = deliveryNotificationBaseKey(item);
    if (!base || base.endsWith(":")) {return false;}
    const before = previous.get(base);
    if (!before) {return seeded && Boolean(item?.dispatchPlanned);}
    return before !== deliveryNotificationKey(item);
  });
  return [...new Map(changed.map((item) => [deliveryNotificationBaseKey(item), item])).values()];
}

/** @param {unknown} value @returns {"en"|"zh-CN"} */
export function pushLanguage(value) {
  return String(value || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/**
 * The page's notification for these items (urgentDeliveryTitle / urgentDeliveryBody / tag).
 * @param {any[]} items @param {number} locationId @param {string} language
 */
export function deliveryPushPayload(items, locationId, language) {
  const text = TEXT[pushLanguage(language)];
  const first = items[0] || {};
  const orderType = first.type === "transfer_order" ? text.transferOrder : text.salesOrder;
  const body = [first.tranid, orderType, first.parkingSpot ? `${text.parkingSpot} ${first.parkingSpot}` : ""].filter(Boolean).join(" | ");
  const notice = deliveryNotificationKey(first).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120);
  return {
    type: "operator_delivery_prep",
    title: items.length === 1 ? text.one : `${items.length} ${text.many}`,
    body,
    tag: `delivery-prep-${locationId}-${notice}`,
    locationId,
    url: "/operator",
    orders: items.slice(0, 10).map((item) => ({ type: item.type, orderId: item.orderId, tranid: item.tranid }))
  };
}

/** @param {any} input */
function cleanSubscription(input) {
  const raw = input?.subscription || input || {};
  let endpoint;
  try { endpoint = new URL(String(raw.endpoint || "")); } catch { endpoint = null; }
  const p256dh = String(raw.keys?.p256dh || "");
  const auth = String(raw.keys?.auth || "");
  if (!endpoint || endpoint.protocol !== "https:" || endpoint.href.length > 4096) {
    throw Object.assign(new Error("A valid HTTPS push subscription endpoint is required."), { status: 400 });
  }
  if (!/^[\w-]{40,1024}={0,2}$/u.test(p256dh) || !/^[\w-]{8,1024}={0,2}$/u.test(auth)) {
    throw Object.assign(new Error("Invalid push subscription keys."), { status: 400 });
  }
  return { endpoint: endpoint.href, p256dh, auth };
}

/** @param {any} operator @param {any} body @param {{userAgent?: string}} [context] */
export async function saveOperatorPushSubscription(operator, body = {}, { userAgent = "" } = {}) {
  if (!operatorPushSettings().enabled) {throw Object.assign(new Error("Push notifications are not configured."), { status: 503 });}
  const locationId = assertOperatorYard(operator, body.locationId);
  const subscription = cleanSubscription(body);
  const language = pushLanguage(body.language);
  const result = await query(
    `INSERT INTO operator_push_subscriptions (operator_id, endpoint, p256dh, auth_secret, location_id, language, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (endpoint) DO UPDATE SET operator_id = EXCLUDED.operator_id, p256dh = EXCLUDED.p256dh,
       auth_secret = EXCLUDED.auth_secret, location_id = EXCLUDED.location_id, language = EXCLUDED.language,
       user_agent = EXCLUDED.user_agent, updated_at = now(), revoked_at = NULL, revoked_reason = NULL, last_error = NULL
     RETURNING id, location_id, language`,
    [String(operator.id), subscription.endpoint, subscription.p256dh, subscription.auth, locationId, language, String(userAgent || "").slice(0, 300)]
  );
  return { ok: true, locationId: result.rows[0].location_id, language: result.rows[0].language };
}

/** @param {any} operator @param {any} body */
export async function revokeOperatorPushSubscription(operator, body = {}) {
  const endpoint = String(body.endpoint || "");
  if (!endpoint) {throw Object.assign(new Error("A push subscription endpoint is required."), { status: 400 });}
  const result = await query(
    `UPDATE operator_push_subscriptions SET revoked_at = now(), revoked_reason = $3, updated_at = now()
      WHERE endpoint = $1 AND operator_id = $2 AND revoked_at IS NULL`,
    [endpoint, String(operator.id), String(body.reason || "operator").slice(0, 40)]
  );
  return { ok: true, revoked: result.rowCount };
}

/** @param {{endpoint:string,p256dh:string,auth_secret:string}} row */
function webPushSubscription(row) {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth_secret } };
}

/** @param {(subscription:any,payload:string,options:any)=>Promise<any>} [send] */
export function createOperatorPushSender(send = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options)) {
  /** @param {any} row @param {any} payload @param {{topic?: string}} [options] */
  return async function deliver(row, payload, { topic = "" } = {}) {
    const settings = operatorPushSettings();
    if (!settings.enabled) {return { sent: false, reason: "disabled" };}
    try {
      await send(webPushSubscription(row), JSON.stringify(payload), {
        TTL: PUSH_TTL_SECONDS, urgency: "high", timeout: 10_000, ...(topic ? { topic } : {}),
        vapidDetails: { subject: settings.subject, publicKey: settings.publicKey, privateKey: settings.privateKey }
      });
      await query("UPDATE operator_push_subscriptions SET last_sent_at = now(), last_error = NULL WHERE id = $1", [row.id]);
      return { sent: true };
    } catch (error) {
      const status = Number(/** @type {any} */ (error)?.statusCode || 0);
      const message = String(/** @type {any} */ (error)?.body || (error instanceof Error ? error.message : error) || "").slice(0, 300);
      if (status === 404 || status === 410) {
        await query(`UPDATE operator_push_subscriptions SET revoked_at = now(), revoked_reason = 'expired', last_error = $2, updated_at = now()
          WHERE id = $1 AND revoked_at IS NULL`, [row.id, message]);
        return { sent: false, reason: "expired" };
      }
      await query("UPDATE operator_push_subscriptions SET last_error = $2 WHERE id = $1", [row.id, `${status || "error"}: ${message}`]);
      return { sent: false, reason: "failed", status };
    }
  };
}

/**
 * A device asks for a real push to itself, to confirm background alerts work end to end.
 * @param {any} operator @param {any} [body] @param {ReturnType<typeof createOperatorPushSender>} [deliver]
 */
export async function sendOperatorPushTest(operator, body = {}, deliver = createOperatorPushSender()) {
  const endpoint = String(body.endpoint || "");
  const row = (await query(
    `SELECT id, endpoint, p256dh, auth_secret, language, last_sent_at FROM operator_push_subscriptions
      WHERE endpoint = $1 AND operator_id = $2 AND revoked_at IS NULL`, [endpoint, String(operator.id)])).rows[0];
  if (!row) {throw Object.assign(new Error("This device is not subscribed to background alerts."), { status: 404 });}
  if (row.last_sent_at && Date.now() - new Date(row.last_sent_at).getTime() < TEST_INTERVAL_MS) {
    return { sent: false, reason: "recent" };
  }
  const text = TEXT[pushLanguage(row.language)];
  return deliver(row, { type: "operator_push_test", title: text.testTitle, body: text.testBody, tag: "operator-push-test", url: "/operator" });
}

/** @param {any} row */
function eligible(row) {
  const roles = [...(Array.isArray(row.roles) ? row.roles : []), row.role];
  if (!row.active || !roles.some((role) => OPERATOR_ROLES.includes(role))) {return false;}
  try {
    return operatorYardLocationIds({ role: row.role, roles: row.roles, operatorYardLocationIds: row.operator_yard_location_ids || [] })
      .includes(Number(row.location_id));
  } catch { return false; }
}

/**
 * One check: per yard with subscribed devices, compare the Delivery Prep alert list with the
 * last one seen and push the changes. Database work runs under a transaction-level advisory
 * lock (one checker at a time); pushes are sent after it commits.
 * @param {{deliver?: ReturnType<typeof createOperatorPushSender>, notifications?: typeof getDeliveryPrepNotifications}} [input]
 */
export async function runOperatorDeliveryPushCheck({ deliver = createOperatorPushSender(), notifications = getDeliveryPrepNotifications } = {}) {
  if (!operatorPushSettings().enabled) {return { enabled: false, sent: 0 };}
  const outbox = [];
  const summary = await withTransaction(async () => {
    const locked = (await query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok", [LOCK_KEY])).rows[0]?.ok;
    if (!locked) {return { locked: false, yards: 0, alerts: 0 };}
    const rows = (await query(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth_secret, s.location_id, s.language,
              o.role, o.roles, o.operator_yard_location_ids, o.active
         FROM operator_push_subscriptions s JOIN operators o ON o.id = s.operator_id
        WHERE s.revoked_at IS NULL AND s.location_id = ANY($1::int[])`, [OPERATOR_YARD_LOCATION_IDS])).rows.filter(eligible);
    const yards = [...new Set(rows.map((row) => Number(row.location_id)))];
    // A yard without devices forgets its list, so its next first device is seeded silently.
    await query("DELETE FROM operator_push_delivery_state WHERE NOT (location_id = ANY($1::int[]))", [yards]);
    await query("DELETE FROM operator_push_yards WHERE NOT (location_id = ANY($1::int[]))", [yards]);
    let alerts = 0;
    for (const locationId of yards) {
      const listed = await notifications({ locationId, allowedOperatorYards: [locationId] });
      // The page sees the JSON response; compare exactly what it would compare.
      const items = JSON.parse(JSON.stringify(Array.isArray(listed?.items) ? listed.items : []));
      const previous = new Map((await query(
        "SELECT base_key, notification_key FROM operator_push_delivery_state WHERE location_id = $1", [locationId]))
        .rows.map((row) => [row.base_key, row.notification_key]));
      const seeded = Boolean((await query(
        "SELECT 1 FROM operator_push_yards WHERE location_id = $1", [locationId])).rowCount);
      const changed = changedDeliveryItems(items, previous, seeded);
      const current = items.filter((item) => !deliveryNotificationBaseKey(item).endsWith(":"));
      await query(
        `DELETE FROM operator_push_delivery_state WHERE location_id = $1 AND NOT (base_key = ANY($2::text[]))`,
        [locationId, current.map(deliveryNotificationBaseKey)]);
      for (const item of current) {
        if (previous.get(deliveryNotificationBaseKey(item)) === deliveryNotificationKey(item)) {continue;}
        await query(
          `INSERT INTO operator_push_delivery_state (location_id, base_key, notification_key) VALUES ($1, $2, $3)
           ON CONFLICT (location_id, base_key) DO UPDATE SET notification_key = EXCLUDED.notification_key, updated_at = now()
           WHERE operator_push_delivery_state.notification_key IS DISTINCT FROM EXCLUDED.notification_key`,
          [locationId, deliveryNotificationBaseKey(item), deliveryNotificationKey(item)]);
      }
      await query(
        `INSERT INTO operator_push_yards (location_id, last_checked_at) VALUES ($1, now())
         ON CONFLICT (location_id) DO UPDATE SET last_checked_at = now()`, [locationId]);
      if (!seeded || !changed.length) {continue;}
      alerts += changed.length;
      const topic = crypto.createHash("sha256").update(`${locationId}:${deliveryNotificationBaseKey(changed[0])}`).digest("base64url").slice(0, 32);
      for (const row of rows.filter((candidate) => Number(candidate.location_id) === locationId)) {
        outbox.push({ row, payload: deliveryPushPayload(changed, locationId, row.language), topic });
      }
    }
    return { locked: true, yards: yards.length, alerts };
  });
  let sent = 0;
  for (const message of outbox) {
    const result = await deliver(message.row, message.payload, { topic: message.topic }).catch(() => ({ sent: false }));
    if (result.sent) {sent += 1;}
  }
  return { enabled: true, ...summary, sent };
}

/**
 * Checks every intervalMs, and soon after a planning event (nudge) so a newly planned order
 * reaches sleeping devices within seconds.
 * @param {{check?: () => Promise<unknown>, intervalMs?: number, nudgeDelayMs?: number, logger?: Pick<Console,'error'>}} [input]
 */
export function createOperatorPushRuntime({ check = () => runOperatorDeliveryPushCheck(), intervalMs = 15_000, nudgeDelayMs = 1500, logger = console } = {}) {
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let nudgeTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let firstTimer = null;
  let running = false;
  let again = false;
  async function tick() {
    if (running) { again = true; return; }
    running = true;
    try { await check(); }
    catch (error) { logger.error("Operator push check failed:", error instanceof Error ? error.message : String(error)); }
    finally {
      running = false;
      if (again) { again = false; void tick(); }
    }
  }
  return {
    tick,
    nudge() {
      if (!timer || nudgeTimer) {return;}
      nudgeTimer = setTimeout(() => { nudgeTimer = null; void tick(); }, nudgeDelayMs);
      nudgeTimer.unref?.();
    },
    start() {
      if (timer) {return;}
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
      firstTimer = setTimeout(() => { firstTimer = null; void tick(); }, 5000);
      firstTimer.unref?.();
    },
    stop() {
      if (timer) {clearInterval(timer);}
      if (nudgeTimer) {clearTimeout(nudgeTimer);}
      if (firstTimer) {clearTimeout(firstTimer);}
      timer = null; nudgeTimer = null; firstTimer = null;
    }
  };
}
