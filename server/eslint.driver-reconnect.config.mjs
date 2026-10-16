import upload from "./eslint.driver-upload.config.mjs";
import recovery from "./eslint.driver-recovery.config.mjs";
export default [{...recovery[0], files: ["test-artifacts/driver-recovery-helpers.js"]}, {
  ...upload[0],
  files: ["public/driver-upload.js", "src/driver-upload-failure*.js", "src/driver-completion-trace.js",
    "test/mbt/unit/driver-reconnect.test.js", "test/mbt/unit/driver-completion-trace.test.js", "test/mbt/property/driver-reconnect.test.js",
    "test/mbt/integration/driver-billing-independent.test.js", "test/driver-reconnect/*.js", "tools/driver-reconnect-*.mjs"],
  languageOptions: {...upload[0].languageOptions, globals: {...upload[0].languageOptions.globals,
    ...Object.fromEntries(["performance", "Event", "EventTarget", "AbortSignal", "window", "document", "photos", "currentJob", "DriverOfflinePhotos", "DriverUpload"].map(name => [name, "readonly"])),
    offlineStorageAvailable: "writable"}}
}];
