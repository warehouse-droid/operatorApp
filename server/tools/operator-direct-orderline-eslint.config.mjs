import base from "./order-line-storage-eslint.config.mjs";
export default [...base, {
  ...base[0],
  files: ["src/operator-netsuite-request-pool.js", "src/config.js"]
}, {
  ...base[0],
  files: ["public/operator.js", "public/service-worker.js"],
  languageOptions: { ...base[0].languageOptions, globals: {
    ...base[0].languageOptions.globals, window: "readonly", document: "readonly", navigator: "readonly",
    localStorage: "readonly", sessionStorage: "readonly", caches: "readonly", self: "readonly", location: "readonly",
    indexedDB: "readonly", Image: "readonly", FileReader: "readonly", File: "readonly", alert: "readonly",
    confirm: "readonly", prompt: "readonly", getComputedStyle: "readonly", requestAnimationFrame: "readonly",
    matchMedia: "readonly", HTMLElement: "readonly", atob: "readonly", btoa: "readonly"
  } }
}];
