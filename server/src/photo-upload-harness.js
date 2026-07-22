import assert from "node:assert/strict";
import { config } from "./config.js";
import { createPhotoReadToken, createPhotoUploadToken, publicPhotoUploadConfig } from "./photo-upload.js";

const original = { ...config.photoUpload };

try {
  config.photoUpload = {
    ...original,
    provider: "local_data_url",
    workerUrl: "",
    tokenSecret: ""
  };
  assert.throws(() => createPhotoUploadToken({
    actor: { login: "test-driver", role: "driver" },
    source: "driver",
    recordType: "driver-stop-photo"
  }), /PHOTO_UPLOAD_WORKER_URL is not configured/);
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

  const readTicket = createPhotoReadToken({
    actor: { login: "test-driver", role: "driver" },
    key: "driver/driver-stop-photo/2026/07/18/TEST/photo.jpg"
  });
  assert.equal(readTicket.objectUrl, "https://photos.example.test/object?key=driver%2Fdriver-stop-photo%2F2026%2F07%2F18%2FTEST%2Fphoto.jpg");
  assert.equal(readTicket.token.split(".").length, 3);

  console.log(JSON.stringify({ ok: true, tests: 8, provider: r2Ticket.provider, readKey: readTicket.key }));
} finally {
  config.photoUpload = original;
}
