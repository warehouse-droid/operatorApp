import assert from "node:assert/strict";

// Desktop browsers cannot display an OS keyboard. Exercise its viewport events
// explicitly, while using real DOM focus, touch taps, layout and scrolling.
export function installKeyboardViewport({ standalone = false } = {}) {
  const viewport = new EventTarget();
  Object.assign(viewport, { height: innerHeight, width: innerWidth, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  window.keyboardViewport = viewport;
  if (standalone) {
    const media = window.matchMedia.bind(window);
    window.matchMedia = query => query === "(display-mode: standalone)"
      ? Object.assign(new EventTarget(), { matches: true }) : media(query);
  }
}

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
export async function assertInputFonts(page, label) {
  const small = await page.evaluate(() => [...document.querySelectorAll('#app input,#app select,#app textarea')]
    .filter(input => input.getClientRects().length && !input.matches('[type="checkbox"],[type="radio"],[type="color"],[type="hidden"]'))
    .map(input => ({ field: input.id || input.name || input.outerHTML.slice(0, 100), size: parseFloat(getComputedStyle(input).fontSize) }))
    .filter(input => input.size < 25));
  assert.deepEqual(small, [], `${label}: all input text must be at least 25px`);
}

export async function checkInputPreferences(page, scene, results, label) {
  await scene(page, "delivery");
  try {
    for (const size of [8, 18, 25, 31]) {
      await page.evaluate(size => {
        let style = document.getElementById("input-font-test");
        if (!style) { style = document.createElement("style"); style.id = "input-font-test"; document.head.append(style); }
        style.textContent = OperatorDisplaySettings.styleCss(OperatorDisplaySettings.normalize({
          styles: { general: { quantities: { fontSizePx: size } }, detail: { quantities: { fontSizePx: size } } }
        }));
      }, size);
      await assertInputFonts(page, `${label}/custom size ${size}`);
      const sizes = await page.locator(".stepper input").evaluateAll(inputs => inputs.map(input => parseFloat(getComputedStyle(input).fontSize)));
      assert.ok(sizes.length > 0);
      assert.ok(sizes.every(actual => actual === Math.max(25, size)), `${label}: larger preferences preserved, small preferences clamped`);
    }
  } finally { await page.locator("#input-font-test").evaluate(style => style.remove()); }
  results.push({ label: `${label}: 25px minimum and larger custom input fonts`, pass: true });
}

async function viewport(page, values) {
  await page.evaluate(values => {
    Object.assign(window.keyboardViewport, values);
    window.keyboardViewport.dispatchEvent(new Event("resize"));
    window.keyboardViewport.dispatchEvent(new Event("scroll"));
  }, values);
  await settle(page);
}

export async function checkPhoneKeypad(page, scene, results, label) {
  for (const [name, id] of [["customer-pickup-scan", "customerPickupScan"], ["stock-lookup", "returnOrderLookup"]]) {
    await scene(page, name);
    const field = page.locator(`#${id}`);
    await field.evaluate(input => {
      window.keypadTrace = [];
      for (const type of ["pointerdown", "pointerup", "click", "focusin", "focusout", "input"]) {
        document.getElementById("app").addEventListener(type, event => {
          window.keypadTrace.push({ type, target: event.target.id || event.target.dataset.orderKey,
            value: input.value, start: input.selectionStart, end: input.selectionEnd });
        }, { capture: true });
      }
    });
    await field.evaluate(input => { input.inputMode = "none"; input.value = ""; input.setSelectionRange(0, 0); });
    const key = value => page.locator(`[data-order-target="${id}"][data-order-key="${value}"]`);
    for (const value of ["SOB", "0", "0", "4"]) await key(value).tap();
    assert.equal(await field.inputValue(), "SOB004", `${label}/${name}: keypad value`);
    assert.equal(await field.evaluate(input => input === document.activeElement), false, `${label}/${name}: keypad must not focus input`);
    await field.tap();
    assert.equal(await field.evaluate(input => input === document.activeElement && input.inputMode === "text"), true, `${label}/${name}: direct tap enables device keyboard`);
    await field.fill("SOB121756");
    await field.evaluate(input => input.setSelectionRange(3, 6));
    await key("4").tap();
    assert.equal(await field.inputValue(), "SOB4756", `${label}/${name}: selected digits replaced`);
    assert.equal(await field.evaluate(input => input === document.activeElement), false, `${label}/${name}: keypad dismisses open keyboard`);
    await key("back").tap();
    assert.equal(await field.inputValue(), "SOB756", `${label}/${name}: caret survives blur ${JSON.stringify(await page.evaluate(() => window.keypadTrace.slice(-12)))}`);
    if (id === "customerPickupScan") {
      await page.waitForTimeout(1350);
      assert.equal(await field.evaluate(input => input === document.activeElement), false, `${label}: scanner timer must not reopen keyboard`);
    }
    await field.tap();
    assert.equal(await field.evaluate(input => input === document.activeElement && input.inputMode === "text"), true, `${label}/${name}: direct typing still available after keypad`);
    await key("clear").tap();
    assert.equal(await field.inputValue(), "");
    results.push({ label: `${label}/${name}: keypad, direct typing, caret and keyboard dismissal`, pass: true });
  }
}

export async function checkPhoneKeyboardScroll(page, results, label) {
  await page.evaluate(() => {
    document.getElementById("app").innerHTML = `<header class="topbar"><h1>Keyboard scroll fixture</h1></header>
      <section class="module-menu" style="display:block"><div style="height:1000px"></div>
      <label>Notes<textarea id="keyboardNotes" style="width:100%;height:90px">Existing note</textarea></label>
      <button id="keyboardDone" type="button">Done</button></section>`;
    const app = document.getElementById("app");
    app.scrollTop = app.scrollHeight;
    document.getElementById("keyboardNotes").focus({ preventScroll: true });
  });
  await settle(page);
  const before = await page.locator("#app").evaluate(app => ({ padding: getComputedStyle(app).paddingBottom, range: app.scrollHeight - app.clientHeight }));
  for (const [name, values] of [
    ["keyboard open", { height: 344, offsetTop: 0, scale: 1 }],
    ["keyboard panned", { height: 300, offsetTop: 95, scale: 1 }],
    ["keyboard grows", { height: 260, offsetTop: 0, scale: 1 }]
  ]) {
    await viewport(page, values);
    const bounds = await page.locator("#keyboardNotes").boundingBox();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.operatorKeyboard), "true", `${label}/${name}: keyboard detected`);
    assert.ok(bounds.y >= values.offsetTop + 11, `${label}/${name}: input above visible top`);
    assert.ok(bounds.y + bounds.height <= values.offsetTop + values.height - 23, `${label}/${name}: input covered by keyboard`);
    assert.ok(await page.locator("#app").evaluate((app, range) => app.scrollHeight - app.clientHeight > range, before.range), `${label}/${name}: extra scroll range`);
    assert.equal(await page.locator("#keyboardNotes").inputValue(), "Existing note");
    results.push({ label: `${label}/${name}: focused field reachable above keyboard`, pass: true });
  }
  await viewport(page, { height: 844, offsetTop: 0, scale: 1 });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.operatorKeyboard), undefined);
  assert.equal(await page.locator("#app").evaluate(app => getComputedStyle(app).paddingBottom), before.padding);
  // Browser bars and pinch zoom must not leave a large empty scroll area.
  for (const values of [{ height: 780, scale: 1 }, { height: 344, scale: 2 }]) {
    await viewport(page, values);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.operatorKeyboard), undefined);
  }
  await viewport(page, { height: 844, offsetTop: 0, scale: 1 });
  await page.locator("#keyboardNotes").evaluate(input => input.blur());
  results.push({ label: `${label}: keyboard close restores space; browser bars and zoom ignored`, pass: true });
}
