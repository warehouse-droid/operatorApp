const fs = require("node:fs");
const { chromium } = require("/app/node_modules/playwright");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 1.5 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://**/*", route => route.abort());
    await page.route("https://**/*", route => route.abort());
    await page.goto("file:///app/test-artifacts/BIN-bin-order-workflows.html");
    await page.evaluate(() => document.fonts.ready);

    for (const id of ["model", "exchange", "collection"]) {
      await page.locator(`#${id}`).screenshot({ path: `/app/test-artifacts/${id}.png` });
    }
    const svgOverflows = await page.evaluate(() => [...document.querySelectorAll("svg text")].flatMap(el => {
      const b = el.getBBox();
      const view = el.ownerSVGElement.viewBox.baseVal;
      return b.x < 0 || b.y < 0 || b.x + b.width > view.width || b.y + b.height > view.height
        ? [{ text: el.textContent, bounds: {x:b.x,y:b.y,width:b.width,height:b.height} }]
        : [];
    }));

    await page.emulateMedia({ media: "print" });
    await page.setViewportSize({width: 1039, height: 710});
    const printHeights = await page.locator(".page").evaluateAll(elements => elements.map(el => ({
      id: el.id, height: el.getBoundingClientRect().height,
    })));
    await page.pdf({
      path: "/app/test-artifacts/BIN-bin-order-workflows.pdf",
      preferCSSPageSize: true,
      printBackground: true,
      tagged: true,
      outline: true,
      displayHeaderFooter: false,
    });

    await page.emulateMedia({media:"screen"});
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download").click();
    const download = await downloadPromise;
    const result = {
      pageErrors: errors,
      svgTextOverflows: svgOverflows,
      printSectionHeights: printHeights,
      downloadFilename: download.suggestedFilename(),
      htmlBytes: fs.statSync("/app/test-artifacts/BIN-bin-order-workflows.html").size,
      pdfBytes: fs.statSync("/app/test-artifacts/BIN-bin-order-workflows.pdf").size,
      pdfPageCount: (fs.readFileSync("/app/test-artifacts/BIN-bin-order-workflows.pdf").toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length,
    };
    fs.writeFileSync("/app/test-artifacts/render-result.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (errors.length || svgOverflows.length || result.pdfPageCount !== 3) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
