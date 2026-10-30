import upload from "./eslint.driver-upload.config.mjs";
export default [{...upload[0], files: ["public/driver-upload.js", "test/support/driver-upload-wait-fixture.mjs",
  "test/mbt/unit/driver-upload-wait.test.js", "test/mbt/property/driver-upload-wait.test.js", "tools/driver-upload-wait-*.mjs"],
  languageOptions: {...upload[0].languageOptions, globals: {...upload[0].languageOptions.globals, performance: "readonly"}}
}];
