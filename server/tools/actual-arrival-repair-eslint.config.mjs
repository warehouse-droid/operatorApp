import base from "../eslint.mbt.config.js";
import { readFileSync } from "node:fs";
const files = JSON.parse(readFileSync(new URL("./actual-arrival-repair-files.json", import.meta.url), "utf8"));
export default [{ ...base[1], files: [...files.production, ...files.tests].filter(file => /\.(js|mjs)$/u.test(file)).concat("tools/actual-arrival-*.mjs"),
  languageOptions: { ...base[1].languageOptions, globals: { ...base[1].languageOptions.globals, globalThis: "readonly", window: "readonly", document: "readonly", localStorage: "readonly", sessionStorage: "readonly", navigator: "readonly", location: "readonly", history: "readonly", alert: "readonly", confirm: "readonly" } } }];
