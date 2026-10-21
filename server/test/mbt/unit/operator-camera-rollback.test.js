import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import fc from "fast-check";
import { mutateCamera } from "../../../tools/operator-camera-rollback-mutants.mjs";

const source = mutateCamera(readFileSync(process.env.OPERATOR_CAMERA_SOURCE || "public/operator.js", "utf8"), process.env.OPERATOR_CAMERA_MUTANT);
const names = ["useBasicCameraCapture", "cameraCaptureMode", "cameraVideoConstraints", "cameraMediaConstraints",
  "cameraLabelMatchesFacing", "listVideoInputDevices", "pickCameraDevice", "rememberCameraStream",
  "maximizeCameraStreamResolution", "prepareCameraStream", "openCameraStream", "cancelOperatorPhotoCameraOpening",
  "stopFulfillmentCamera", "stopReceiptCamera", "stopReturnCamera", "stopOperatorPhotoCameras",
  "operatorPhotoCameraContext", "captureCameraPhotoDataUrl"];
const extract = name => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  if (!match) return "";
  return source.slice(match.index, match.index + source.slice(match.index).match(/^}/m).index + 1);
};

function setup({ android = true, stall = false, error, devices = [] } = {}) {
  const state = { calls: [], constraints: [], streams: [], photoCalls: 0, canvasCalls: 0, release: [] };
  const context = vm.createContext({
    navigator: { userAgent: android ? "Mozilla/5.0 (Linux; Android 14; Tablet)" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      mediaDevices: { enumerateDevices: async () => devices, getUserMedia: async constraints => {
        state.calls.push(constraints);
        const problem = typeof error === "function" ? error(state.calls.length) : error;
        if (problem) throw Object.assign(new Error(problem), { name: problem });
        const track = { stopped: false, getSettings: () => ({ deviceId: "rear" }),
          getCapabilities: () => ({ width: { max: 8192 }, height: { max: 6144 }, focusMode: ["continuous"] }),
          applyConstraints: async value => { state.constraints.push(value); if (stall) await new Promise(resolve => state.release.push(Object.assign(resolve, { track }))); },
          stop() { this.stopped = true; } };
        const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
        state.streams.push(stream); return stream;
      } },
    },
    operatorPhotoCamera: { key: "test", opening: "fulfillment", request: 1, pending: null },
    OPERATOR_CAMERA_IDEAL_WIDTH: 4096, OPERATOR_CAMERA_IDEAL_HEIGHT: 3072, OPERATOR_CAMERA_JPEG_QUALITY: 0.92,
    cameraFacingMode: "environment", lastCameraDeviceId: "", fulfillmentCameraStream: null, fulfillmentCameraActive: false,
    receiptCameraStream: null, receiptCameraActive: false, returnCameraStream: null, returnCameraActive: false,
    operatorInventory: { stopCamera() {} }, operator: { id: "test" }, operatorWorkspaceLeaving: false,
    currentModule: "delivery-fulfill", fulfillmentOrder: { netsuite_id: "test" }, fulfillmentSubmitting: false,
    fulfillmentResult: null, fulfillmentLoadRequestId: "test", fulfillmentRequiredPhotoCount: () => 1,
    app: { querySelector: () => ({}) },
    HTMLVideoElement: class {},
    document: { getElementById: () => null, visibilityState: "visible", createElement: () => ({ getContext: () => ({ drawImage() { state.canvasCalls++; } }), toDataURL: () => "data:image/jpeg;base64,Y2FudmFz" }) },
    window: { ImageCapture: class { async takePhoto() { state.photoCalls++; return { size: 1 }; } } },
    readPhotoFile: async () => "data:image/jpeg;base64,cGhvdG8=", t: (_key, fallback) => fallback,
  });
  vm.runInContext(names.map(extract).join("\n"), context);
  return { state, context };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test("Android uses historical browser-selected dimensions without sensor or autofocus reconfiguration", async () => {
  const { state, context } = setup();
  await context.openCameraStream();
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].video.facingMode.exact, "environment");
  assert.equal(state.calls[0].video.width, undefined);
  assert.equal(state.calls[0].video.height, undefined);
  assert.deepEqual(state.constraints, []);
});

test("Windows retains high-resolution preview and still capture", async () => {
  const { state, context } = setup({ android: false });
  const stream = await context.openCameraStream();
  assert.equal(state.calls[0].video.width.ideal, 4096);
  assert.equal(state.constraints[0].width.ideal, 8192);
  assert.equal(state.constraints[1].advanced[0].focusMode, "continuous");
  assert.equal(await context.captureCameraPhotoDataUrl(stream, { videoWidth: 640, videoHeight: 480 }), "data:image/jpeg;base64,cGhvdG8=");
  assert.equal(state.photoCalls, 1);
  assert.equal(state.canvasCalls, 0);
});

test("Android still capture uses the previous canvas path without ImageCapture", async () => {
  const { state, context } = setup();
  const stream = await context.openCameraStream();
  assert.equal(await context.captureCameraPhotoDataUrl(stream, { videoWidth: 640, videoHeight: 480 }), "data:image/jpeg;base64,Y2FudmFz");
  assert.equal(state.photoCalls, 0);
  assert.equal(state.canvasCalls, 1);
});

test("Close releases an acquired camera even when platform preparation never resolves", async () => {
  const { state, context } = setup({ android: false, stall: true });
  void context.openCameraStream(() => context.operatorPhotoCamera.request === 1).catch(() => {});
  await turn();
  assert.equal(state.streams.length, 1);
  assert.equal(state.release.length, 1, "Fault injection must reach pending applyConstraints");
  context.stopFulfillmentCamera();
  assert.equal(state.streams[0].getVideoTracks()[0].stopped, true);
  assert.equal(context.operatorPhotoCamera.pending, null);
});

test("a hidden photo screen is not eligible to acquire a camera", () => {
  const { context } = setup();
  assert.equal(context.operatorPhotoCameraContext().kind, "fulfillment");
  context.document.visibilityState = "hidden";
  assert.equal(context.operatorPhotoCameraContext(), null);
});

for (const error of ["NotReadableError", "AbortError", "NotAllowedError", "SecurityError"]) {
  test(`${error} stops acquisition after one request`, async () => {
    const { context, state } = setup({ error, devices: [{ kind: "videoinput", label: "Rear camera", deviceId: "rear" }] });
    await assert.rejects(context.openCameraStream(), failure => failure.name === error);
    assert.equal(state.calls.length, 1);
  });
}

test("unsupported facing mode retains camera-selection fallback", async () => {
  const { context, state } = setup({ error: call => call === 1 ? "OverconstrainedError" : null,
    devices: [{ kind: "videoinput", label: "Rear camera", deviceId: "rear" }] });
  const stream = await context.openCameraStream();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].video.deviceId.exact, "rear");
  assert.equal(stream.getTracks()[0].stopped, false);
});

test("property: cancellation and late preparation cannot retain an old stream or stop a new one", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async releaseBeforeNew => {
    const { context, state } = setup({ android: false, stall: true });
    const first = context.openCameraStream(() => context.operatorPhotoCamera.request === 1).catch(() => null);
    await turn();
    context.stopFulfillmentCamera();
    assert.equal(state.streams[0].getTracks()[0].stopped, true);
    const finishOld = async () => {
      const oldTrack = state.streams[0].getTracks()[0];
      for (let i = 0; i < 3; i++) {
        const oldCallbacks = state.release.filter(resolve => resolve.track === oldTrack);
        state.release = state.release.filter(resolve => resolve.track !== oldTrack);
        oldCallbacks.forEach(resolve => resolve());
        await turn();
      }
      await first;
    };
    if (releaseBeforeNew) await finishOld();
    context.operatorPhotoCamera.opening = "fulfillment";
    const secondRequest = context.operatorPhotoCamera.request;
    const second = context.openCameraStream(() => context.operatorPhotoCamera.request === secondRequest).catch(() => null);
    await turn();
    if (!releaseBeforeNew) await finishOld();
    assert.equal(state.streams[1].getTracks()[0].stopped, false);
    context.stopFulfillmentCamera();
    assert(state.streams.every(stream => stream.getTracks()[0].stopped));
    for (let i = 0; i < 4; i++) { state.release.splice(0).forEach(resolve => resolve()); await turn(); }
    await Promise.all([first, second]);
    assert.equal(context.operatorPhotoCamera.pending, null);
  }), { seed: 20260930, numRuns: 12 });
});
