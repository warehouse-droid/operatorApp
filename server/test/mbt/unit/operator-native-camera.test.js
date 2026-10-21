import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import fc from "fast-check";

let source = readFileSync(process.env.OPERATOR_NATIVE_SOURCE || "public/operator.js", "utf8");
const mutant = process.env.OPERATOR_NATIVE_MUTANT;
const changes = {
  stale: ['if (operatorPhotoCameraContext(true)?.key !== key) return;', 'if (false) return;'],
  hidden: ['operatorPhotoCameraContext(true)?.key', 'operatorPhotoCameraContext()?.key'],
  discard: ['receiptPhotoDataUrls[slot] = photo;', 'receiptPhotoDataUrls[slot] = "";'],
  cleanup: ['if (nativeCameraInput === input) nativeCameraInput = null;', 'if (false) nativeCameraInput = null;'],
  duplicate: ['if (nativeCameraInput) return Promise.resolve(null);', 'if (false) return Promise.resolve(null);'],
  windows: ['(/Linux/i.test(agent.userAgent) || agent.userAgentData?.platform === "Linux")', 'true'],
};
if (mutant) { const [before, after] = changes[mutant]; assert(source.includes(before)); source = source.replace(before, after); }
const extract = name => { const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m")); assert(start >= 0, name); return source.slice(start, start + source.slice(start).search(/^}/m) + 1); };
function setup({ clickError = false } = {}) {
  const inputs = [], reads = [], errors = [];
  const context = vm.createContext({
    nativeCameraInput: null, cameraCaptureMode: () => "environment", currentModule: "receiving-receipt",
    window: { MBBSOperatorPhone: { enabled: () => true } },
    document: { visibilityState: "visible", body: { appendChild() {} }, createElement() {
      const handlers = {}, input = { files: [], handlers, setAttribute(name, value) { this[name] = value; },
        addEventListener: (name, fn) => { handlers[name] = fn; }, remove() { this.removed = true; },
        click() { if (clickError) throw new Error("picker blocked"); } };
      inputs.push(input); return input;
    } },
    operator: { id: "test" }, operatorWorkspaceLeaving: false,
    app: { querySelector: () => ({}) }, receiptOrder: { netsuite_id: "A" }, receiptRequestId: "1",
    receiptSubmitting: false, receiptResult: null, receiptPhotoDataUrls: [], receiptActivePhotoSlot: 0,
    returnPhotoTarget: {}, render() {}, showToast: error => errors.push(error),
    t: (_key, fallback) => fallback,
    readPhotoFile: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
  });
  vm.runInContext(["useBasicCameraCapture", "captureNativeCameraPhoto", "captureNativeOperatorPhoto", "operatorPhotoCameraContext", "returnModuleActive", "nextPhotoSlot"].map(extract).join("\n"), context);
  return { context, inputs, reads, errors };
}

test("camera device gate covers Android desktop mode and preserves Windows touch tablets", () => {
  const { context } = setup();
  for (const [userAgent, platform, maxTouchPoints, expected] of [
    ["Android 14", "Android", 10, true], ["X11; Linux x86_64", "Linux", 10, true],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iOS", 5, true],
    ["Mozilla/5.0 (iPod touch; CPU iPhone OS 18_0 like Mac OS X)", "iOS", 5, true],
    ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", "iOS", 5, false],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "macOS", 5, false],
    ["Windows NT 10.0", "Windows", 10, false], ["X11; Linux x86_64", "Linux", 0, false],
  ]) {
    context.navigator = { userAgent, userAgentData: { platform }, maxTouchPoints };
    assert.equal(context.useBasicCameraCapture(), expected, `${platform}, touch=${maxTouchPoints}`);
  }
});

test("disabling the phone gate preserves the previous iPhone and tablet camera behavior", () => {
  const { context } = setup();
  context.window.MBBSOperatorPhone.enabled = () => false;
  for (const [userAgent, expected] of [["iPhone", false], ["iPod", false], ["iPad", false], ["Android 14", true]]) {
    context.navigator = { userAgent, maxTouchPoints: 5 };
    assert.equal(context.useBasicCameraCapture(), expected);
  }
});

test("native picker cancels, cleans up and permits a later camera tap", async () => {
  const { context, inputs } = setup();
  const first = context.captureNativeCameraPhoto();
  const duplicate = context.captureNativeCameraPhoto();
  assert.equal(inputs.length, 1);
  assert.equal(await duplicate, null, "Only one native camera intent at a time");
  assert.equal(inputs[0].capture, "environment");
  inputs[0].handlers.cancel(); assert.equal(await first, null);
  assert.equal(inputs[0].removed, true); assert.equal(context.nativeCameraInput, null);
  const next = context.captureNativeCameraPhoto("user");
  assert.equal(inputs.length, 2); assert.equal(inputs[1].capture, "user");
  inputs[1].handlers.cancel(); await next;
});

test("native picker rejects invalid files and read errors without retaining the input", async () => {
  for (const type of ["text/plain", "image/jpeg"]) {
    const { context, inputs, reads } = setup(); const pending = context.captureNativeCameraPhoto();
    const rejected = assert.rejects(pending, type === "text/plain" ? /take a photo/ : /read failed/);
    inputs[0].files = [{ type }]; const reading = inputs[0].handlers.change();
    if (reads.length) reads[0].reject(new Error("read failed"));
    await reading; await rejected;
    assert.equal(context.nativeCameraInput, null); assert.equal(inputs[0].removed, true);
  }
});

test("a platform failure to open the picker permits the next attempt", async () => {
  const { context, inputs } = setup({ clickError: true });
  await assert.rejects(context.captureNativeCameraPhoto(), /picker blocked/);
  assert.equal(context.nativeCameraInput, null);
  assert.equal(inputs[0].removed, true);
});

test("property: native photos survive background but cannot cross order or request identity", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom("same", "order", "request", "leave"), fc.integer({ min: 0, max: 4 }), async (hidden, change, slot) => {
    const { context, inputs, reads, errors } = setup();
    context.receiptActivePhotoSlot = slot;
    const pending = context.captureNativeOperatorPhoto(context.operatorPhotoCameraContext());
    inputs[0].files = [{ type: "image/jpeg" }]; const reading = inputs[0].handlers.change();
    if (hidden) context.document.visibilityState = "hidden";
    if (change === "order") context.receiptOrder = { netsuite_id: "B" };
    if (change === "request") context.receiptRequestId = "2";
    if (change === "leave") context.currentModule = "menu";
    reads[0].resolve("data:image/jpeg;base64,cGhvdG8=");
    await reading; await pending;
    assert.equal(context.receiptPhotoDataUrls.filter(Boolean).length, change === "same" ? 1 : 0);
    if (change === "same") assert.equal(context.receiptPhotoDataUrls[slot], "data:image/jpeg;base64,cGhvdG8=");
    assert.equal(context.nativeCameraInput, null); assert.deepEqual(errors, []);
  }), { seed: 20260930, numRuns: 40 });
});
