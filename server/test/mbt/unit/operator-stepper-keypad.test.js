import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

// Operator stepper number pad: the key editing rules and the page wiring.
async function keypad() {
  const context = vm.createContext({});
  context.globalThis = context;
  new vm.Script(await readFile("public/operator-stepper-keypad.js", "utf8"),
    { filename: path.resolve("public/operator-stepper-keypad.js") }).runInContext(context);
  return context.OperatorStepperKeypad;
}

function typeKeys(edit, start, keys, decimals = false) {
  return keys.reduce((state, key) => edit(state, key, decimals), start);
}

test("the first digit replaces the current quantity; later digits append", async () => {
  const { edit } = await keypad();
  assert.deepEqual({ ...edit({ text: "25", fresh: true }, "7") }, { text: "7", fresh: false });
  assert.deepEqual({ ...typeKeys(edit, { text: "25", fresh: true }, ["1", "2"]) }, { text: "12", fresh: false });
  assert.deepEqual({ ...typeKeys(edit, { text: "0", fresh: true }, ["0", "4"]) }, { text: "4", fresh: false });
});

test("backspace edits the shown value and clear empties it", async () => {
  const { edit } = await keypad();
  assert.deepEqual({ ...edit({ text: "25", fresh: true }, "back") }, { text: "2", fresh: false });
  assert.deepEqual({ ...typeKeys(edit, { text: "25", fresh: true }, ["back", "back", "back"]) }, { text: "", fresh: false });
  assert.deepEqual({ ...edit({ text: "25", fresh: true }, "clear") }, { text: "", fresh: false });
});

test("a decimal point is accepted only for fractional units, once, with at most four places", async () => {
  const { edit } = await keypad();
  assert.deepEqual({ ...edit({ text: "3", fresh: true }, ".") }, { text: "3", fresh: true });
  assert.equal(typeKeys(edit, { text: "", fresh: false }, ["2", ".", "5"]).text, "25");
  assert.equal(typeKeys(edit, { text: "3", fresh: true }, [".", "5"], true).text, "0.5");
  assert.equal(typeKeys(edit, { text: "", fresh: false }, ["2", ".", ".", "7", "5"], true).text, "2.75");
  assert.equal(typeKeys(edit, { text: "", fresh: false }, ["1", ".", "1", "2", "3", "4", "5"], true).text, "1.1234");
});

test("whole numbers are capped at seven digits and other keys are ignored", async () => {
  const { edit } = await keypad();
  assert.equal(typeKeys(edit, { text: "", fresh: false }, [..."123456789"]).text, "1234567");
  assert.deepEqual({ ...edit({ text: "8", fresh: true }, "x") }, { text: "8", fresh: true });
});

test("entered text parses to a nonnegative quantity", async () => {
  const { parse } = await keypad();
  assert.equal(parse(""), 0);
  assert.equal(parse("."), 0);
  assert.equal(parse("12."), 12);
  assert.equal(parse("0.5"), 0.5);
  assert.equal(parse("1.1234"), 1.1234);
});

test("the Operator page loads the number pad before operator.js and the service worker precaches it", async () => {
  const html = await readFile("public/operator.html", "utf8");
  const worker = await readFile("public/service-worker.js", "utf8");
  const operator = await readFile("public/operator.js", "utf8");
  const url = html.match(/<script src="(\/operator-stepper-keypad\.js\?v=[^"]+)"><\/script>/u)?.[1];
  assert.ok(url, "versioned number pad script in operator.html");
  assert.ok(html.indexOf(url) < html.indexOf('src="/operator.js?'));
  assert.ok(worker.includes(JSON.stringify(url)), "service worker precaches the number pad");
  assert.match(operator, /window\.OperatorStepperKeypad\.install\(app, stepperKeypadTarget\);/u);
  assert.match(operator, /data-pack="\$\{unit\}" value="\$\{value\}" readonly aria-haspopup="dialog"/u);
});
