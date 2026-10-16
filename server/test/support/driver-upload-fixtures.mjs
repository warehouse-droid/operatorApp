import fs from "node:fs";
import vm from "node:vm";
import {pathToFileURL} from "node:url";

export function loadUpload(overrides = {}) {
  const runtime = {
    Blob, File, FormData, AbortController, URL, setTimeout, clearTimeout,
    crypto: globalThis.crypto,
    ...overrides
  };
  const context = vm.createContext(runtime);
  const source = process.env.DRIVER_UPLOAD_MODULE_FILE ? pathToFileURL(process.env.DRIVER_UPLOAD_MODULE_FILE) : new URL("../../public/driver-upload.js", import.meta.url);
  vm.runInContext(fs.readFileSync(source, "utf8"), context, {filename: source.pathname});
  return context.DriverUpload;
}

export function loadDriverHelpers(overrides = {}) {
  const runtime = {
    Blob, File, FormData, AbortController, URL, setTimeout, clearTimeout, crypto: globalThis.crypto,
    driver: {login: "fixture-driver"}, offlineDeviceId: "fixture-device", authToken: "",
    driverRequestController: new AbortController(), activeDriverMutationToken: null,
    offlineManifest: null, offlineStorageAvailable: false, currentJob: {planDate: "2026-10-13"}, dayState: {},
    t: (_key, fallback) => fallback, refreshOfflineHealth: async () => {},
    uploadStatus: null, navigator: {onLine: false}, DRIVER_PWA_CLIENT_VERSION: "2026.08.12.3",
    ...overrides
  };
  runtime.window = runtime;
  runtime.DriverOfflineDB ||= {markPhotoUploaded: async () => {}};
  const context = vm.createContext(runtime);
  const source = process.env.DRIVER_UPLOAD_MODULE_FILE ? pathToFileURL(process.env.DRIVER_UPLOAD_MODULE_FILE) : new URL("../../public/driver-upload.js", import.meta.url);
  vm.runInContext(fs.readFileSync(source, "utf8"), context, {filename: source.pathname});
  context.driverUploadFailures = context.DriverUpload.failureQueue(memoryStorage());
  context.driverUploadSaveChecks = new Map();
  const driverPath = process.env.DRIVER_UPLOAD_DRIVER_FILE ? pathToFileURL(process.env.DRIVER_UPLOAD_DRIVER_FILE) : new URL("../../public/driver.js", import.meta.url);
  const driverSource = fs.readFileSync(driverPath, "utf8");
  const begin = driverSource.indexOf("function driverUploadOwner()");
  const padded = driverSource.slice(0, begin).replace(/[^\n]/gu, " ")
    + driverSource.slice(begin, driverSource.indexOf("function photoSrc("));
  vm.runInContext(padded, context, {filename: driverPath.pathname});
  return context;
}

export function loadDriverRequest(overrides = {}) {
  const context = loadDriverHelpers({DRIVER_PWA_VERSION_HEADER: "X-MBBS-Driver-Version", applyDriverOfflineMode: () => {},
    requireDriverPwaUpdate: () => {}, t: (_key, fallback) => fallback, ...overrides});
  const driverPath = process.env.DRIVER_UPLOAD_DRIVER_FILE ? pathToFileURL(process.env.DRIVER_UPLOAD_DRIVER_FILE) : new URL("../../public/driver.js", import.meta.url);
  const source = fs.readFileSync(driverPath, "utf8");
  vm.runInContext(source.slice(source.indexOf("async function request("), source.indexOf("function driverRoutePresenceSnapshot(")), context,
    {filename: `${driverPath.pathname}?upload-request`});
  return context;
}

export function memoryStorage() {
  const data = new Map();
  return {getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, String(value))};
}

export function xhrFixture(behavior) {
  const requests = [];
  class FixtureXHR {
    constructor() { this.upload = {}; this.headers = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; queueMicrotask(() => behavior(this)); }
    abort() { this.aborted = true; this.onabort?.(); }
    respond(status, payload) {
      this.status = status;
      this.responseText = typeof payload === "string" ? payload : JSON.stringify(payload);
      this.onload?.();
    }
  }
  return {XMLHttpRequest: FixtureXHR, requests};
}

export function photo(size = 100, id = "fixture-photo") {
  return {photoId: id, blob: new Blob([new Uint8Array(size)], {type: "image/jpeg"}), byteSize: size, mimeType: "image/jpeg"};
}

export function failure(overrides = {}) {
  return {
    failureId: "8d02c61b-f379-4f5a-b7d5-b8a07249c006", stage: "uploading",
    occurredAt: "2026-10-13T11:13:00.000Z", jobId: "fixture-job", photoId: "fixture-photo",
    planDate: "2026-10-13", clientVersion: "2026.08.12.3", assetVersion: "20261013-driver-upload-v1",
    attempt: 1, byteSize: 100, transferredBytes: 50, percentage: 50,
    elapsedMs: 250, httpStatus: 503, errorCode: "driver_photo_upload_http_error",
    message: "Storage unavailable", ...overrides
  };
}
