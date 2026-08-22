import webpush from "web-push";

import { config } from "./config.js";
import {
  listActiveDriverPushSubscriptions,
  revokeDriverPushSubscription
} from "./scm-dependency-management-repository.js";

let configuredKey = "";

function pushConfiguration() {
  const publicKey = String(config.driverRoutePush?.vapidPublicKey || "").trim();
  const privateKey = String(config.driverRoutePush?.vapidPrivateKey || "").trim();
  const subject = String(config.driverRoutePush?.vapidSubject || "").trim();
  return { publicKey, privateKey, subject, enabled: Boolean(publicKey && privateKey && subject) };
}

function configureWebPush() {
  const settings = pushConfiguration();
  if (!settings.enabled) {
    return settings;
  }
  const key = `${settings.subject}\u0000${settings.publicKey}\u0000${settings.privateKey}`;
  if (key !== configuredKey) {
    webpush.setVapidDetails(settings.subject, settings.publicKey, settings.privateKey);
    configuredKey = key;
  }
  return settings;
}

export function driverRoutePushPublicConfiguration() {
  const settings = pushConfiguration();
  return { enabled: settings.enabled, publicKey: settings.enabled ? settings.publicKey : "" };
}

function notificationPayload(request = {}) {
  return JSON.stringify({
    type: "driver_route_change",
    title: "Route update needs your attention",
    body: "Open MBBS Driver and confirm readiness.",
    requestId: String(request.requestId || "")
  });
}

export async function notifyDriverRouteChangeRequest(request = {}) {
  const settings = configureWebPush();
  if (!settings.enabled) {
    return { enabled: false, attempted: 0, delivered: 0, revoked: 0 };
  }
  const expectedDevices = new Set((request.devices || []).map((device) => (
    `${String(device.driverLogin || "").trim().toLowerCase()}|${String(device.deviceId || "").trim()}`
  )));
  const logins = [...new Set((request.devices || [])
    .map((device) => String(device.driverLogin || "").trim().toLowerCase())
    .filter(Boolean))];
  const subscriptions = (await listActiveDriverPushSubscriptions(logins)).filter((entry) => (
    expectedDevices.has(`${entry.driverLogin.toLowerCase()}|${entry.deviceId}`)
  ));
  const payload = notificationPayload(request);
  let delivered = 0;
  let revoked = 0;
  await Promise.all(subscriptions.map(async (entry) => {
    try {
      await webpush.sendNotification(entry.subscription, payload, {
        TTL: 120,
        urgency: "high",
        topic: `route-${String(request.requestId || "").replaceAll("-", "").slice(0, 24)}`
      });
      delivered += 1;
    } catch (error) {
      if ([404, 410].includes(Number(error?.statusCode || 0))) {
        await revokeDriverPushSubscription({
          driverLogin: entry.driverLogin,
          deviceId: entry.deviceId,
          endpoint: entry.subscription.endpoint
        });
        revoked += 1;
      }
    }
  }));
  return { enabled: true, attempted: subscriptions.length, delivered, revoked };
}
