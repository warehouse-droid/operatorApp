// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [configHtml, assetHtml, shellClient] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-assets.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8")
]);

test("creation forms do not force operators to invent an audit reason", () => {
  const customItemForm = configHtml.match(/id="customLocalItemForm"([\s\S]*?)<\/form>/u)?.[1] || "";
  assert.doesNotMatch(customItemForm, /Audit reason/u);
  assert.doesNotMatch(customItemForm, /customLocalItemReason/u);
  assert.doesNotMatch(assetHtml, /id=["']assetReason["']/u);

  for (const id of ["customerImportReason", "dumpSiteReason", "rateCardReason"]) {
    const control = configHtml.match(new RegExp(`<textarea[^>]+id=["']${id}["'][^>]*>`, "u"))?.[0] || "";
    assert.ok(control, `${id} remains available when an audited update needs context`);
    assert.doesNotMatch(control, /\srequired(?:\s|>|=)/u);
  }
  assert.match(shellClient, /defaultCreationReason/u);
});
