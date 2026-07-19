import assert from "node:assert/strict";
import { config } from "./config.js";
import { createPhotoUploadToken, publicPhotoUploadConfig } from "./photo-upload.js";

const original = { ...config.photoUpload };

try {
  config.photoUpload = {
    ...original,
    provider: "local_data_url",
    workerUrl: "",
    tokenSecret: ""
  };
  const localTicket = createPhotoUploadToken({
    actor: { login: "test-driver", role: "driver" },
    source: "driver",
    recordType: "driver-stop-photo"
  });
  assert.equal(localTicket.provider, "local_data_url");
  assert.equal(localTicket.uploadUrl, "");
  assert.equal(localTicket.token, "");
  assert.equal(publicPhotoUploadConfig().workerConfigured, false);

  config.photoUpload = {
    ...original,
    provider: "r2_worker",
    workerUrl: "https://photos.example.test",
    tokenSecret: "test-secret"
  };
  const r2Ticket = createPhotoUploadToken({
    actor: { login: "test-driver", role: "driver" },
    source: "driver",
    recordType: "driver-pickup-photo",
    metadata: { jobId: "TEST-JOB" }
  });
  assert.equal(r2Ticket.provider, "r2_worker");
  assert.equal(r2Ticket.uploadUrl, "https://photos.example.test/upload");
  assert.equal(r2Ticket.token.split(".").length, 3);
  assert.equal(publicPhotoUploadConfig().workerConfigured, true);

  console.log(JSON.stringify({ ok: true, tests: 8, providers: [localTicket.provider, r2Ticket.provider] }));
} finally {
  config.photoUpload = original;
}
