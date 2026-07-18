import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [operator, css, operatorHtml, serviceWorker, server, sidebar, dispatchMenu, schedule, scheduleHtml, i18n] = await Promise.all([
  "../public/operator.js",
  "../public/operator.css",
  "../public/operator.html",
  "../public/service-worker.js",
  "server.js",
  "../public/app-sidebar.js",
  "../public/dispatch-menu.html",
  "../public/scm-schedule.js",
  "../public/scm-schedule.html",
  "../public/i18n.js"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

function includesAll(source, values, label) {
  for (const value of values) assert.ok(source.includes(value), label + " is missing: " + value);
}

includesAll(operator, [
  "navigator.mediaDevices.getUserMedia",
  "facingMode: { exact: facing }",
  "function selectRearCamera()",
  "maximizeCameraStreamResolution",
  "track.getCapabilities()",
  "track.applyConstraints(resolution)",
  "capabilities.width?.max",
  "capabilities.height?.max",
  "imageCapture.getPhotoCapabilities?.()",
  "imageCapture.takePhoto(photoSettings)",
  "OPERATOR_CAMERA_IDEAL_WIDTH = 4096",
  "OPERATOR_CAMERA_IDEAL_HEIGHT = 3072",
  "window.requestAnimationFrame(attachFulfillmentCamera)",
  "window.requestAnimationFrame(attachReceiptCamera)",
  'data-action="stop-camera"',
  'data-action="stop-receipt-camera"',
  'window.addEventListener("pagehide"'
], "Operator in-PWA camera");

assert.equal((operator.match(/selectRearCamera\(\);/g) || []).length, 2, "Both operator photo workflows must default to the rear camera.");
assert.ok(!operator.includes('id="fulfillmentPhoto"'), "Fulfillment must not expose a photo file input.");
assert.ok(!operator.includes('id="receiptPhoto"'), "Receiving must not expose a photo file input.");
assert.ok(!operator.includes('type="file"'), "Operator PWA must not expose file/gallery upload inputs.");
assert.ok(!operator.includes("nativeCamera.click()"), "Operator PWA must not invoke a native file picker.");
assert.ok(!operator.includes('event.target?.id !== "fulfillmentPhoto"'), "Legacy photo upload change handler must be removed.");
assert.ok(/fulfillmentPhotoDataUrls\.filter\(Boolean\)\.length < 2/.test(operator), "Fulfillment must keep the two-photo minimum.");
assert.ok(/receiptPhotoDataUrls\.filter\(Boolean\)\.length < 2/.test(operator), "Receiving must keep the two-photo minimum.");
assert.ok(!/captureFulfillmentPhoto\(\)[\s\S]{0,700}stopFulfillmentCamera\(\);\s+render\(\);/.test(operator), "Fulfillment capture should keep the stream open for the next photo.");
assert.ok(!/captureReceiptPhoto\(\)[\s\S]{0,700}stopReceiptCamera\(\);\s+render\(\);/.test(operator), "Receiving capture should keep the stream open for the next photo.");
assert.ok(css.includes(".camera-preview.mirrored"), "Only the front-camera preview should be mirrored.");
assert.ok(!/\.camera-preview\s*\{\s*transform:\s*scaleX/.test(css), "Rear-camera preview must not be mirrored.");
assert.ok(!css.includes('input[type="file"]'), "Upload-specific operator CSS must be removed.");
includesAll(i18n, [
  '"common.closeCamera"',
  '"operator.cameraPermissionRequired"',
  '"operator.rearCameraUnavailable"',
  '"operator.cameraPreviewNotReady"'
], "Bilingual camera strings");
includesAll(operatorHtml, [
  "/operator.css?v=20260717-in-pwa-camera-v1",
  "/operator.js?v=20260717-in-pwa-camera-v1"
], "Operator camera cache busting");
assert.ok(serviceWorker.includes("mbbs-yard-operator-v115-in-pwa-camera"), "Operator service-worker cache must advance.");

includesAll(server, [
  'app.get(["/dispatch/po-to-schedule", "/dispatch/POTOschedule"]',
  'res.sendFile(path.join(publicDir, "scm-schedule.html"))'
], "Dispatch PO/TO Schedule route");
assert.ok(sidebar.includes('{ label: "PO/TO Schedule", href: "/dispatch/po-to-schedule"'), "Dispatch sidebar schedule entry missing.");
assert.ok(dispatchMenu.includes("location.href='/dispatch/po-to-schedule'"), "Dispatch menu schedule entry missing.");
includesAll(schedule, [
  'window.location.pathname.startsWith("/dispatch/")',
  'scmScheduleDispatchHost ? "Dispatch" : "SCM"',
  'scmScheduleDispatchHost ? "/dispatch" : "/scm"',
  'roles: ["admin", "scm", "scm_staff", "dispatcher"]',
  'if (role === "dispatcher") return ["dispatch", "completed"];'
], "Shared schedule host and dispatcher access");
assert.ok(scheduleHtml.includes("/scm-schedule.js?v=20260718-schedule-multifilter-v3"), "Shared schedule client cache busting missing.");

console.log("Operator camera and Dispatch PO/TO Schedule harness passed.");
