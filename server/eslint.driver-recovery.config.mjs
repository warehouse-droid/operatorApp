import upload from "./eslint.driver-upload.config.mjs";
export default [{
  ...upload[0],
  files: ["test/mbt/property/driver-upload-recovery.test.js", "test/mbt/unit/driver-upload-recovery.test.js",
    "test/driver-upload-recovery/*.js", "test/driver-upload-recovery.playwright.config.mjs", "tools/driver-upload-recovery-*.mjs",
    "test-artifacts/driver-recovery-helpers.js"],
  languageOptions: {...upload[0].languageOptions, globals: {...upload[0].languageOptions.globals,
    ...Object.fromEntries(["window", "document", "currentJob", "activeDriverMutationToken", "driverUploadSaveChecks", "photoPromptOpen", "photos",
      "driver", "offlineDeviceId", "authToken", "driverRequestController", "driverUploadFailures", "uploadStatus", "t", "tf", "offlineManifest",
      "offlineStorageAvailable", "dayState", "DRIVER_PWA_CLIENT_VERSION", "request", "dataUrlToFile", "isDriverBinJob", "driverRemark",
      "binDraft", "locationCheck", "locationOverrideApproval", "onlineBinEventAttempts", "loadNextJob", "showToast", "renderJob", "refreshOfflineHealth"]
      .map(name => [name, "writable"]))}},
  rules: {...upload[0].rules, "no-unused-vars": ["error", {argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^(uploadDriverPhotos|finishPendingDriverPhotoCompletion|driverSignaturePayload|saveDriverPhotoAction|onlineBinEventAttempt|finishOnlineBinEventAttempt|onlineBinPhotoDescriptors)$"}]}
}];
