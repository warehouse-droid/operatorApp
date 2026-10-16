import {normalizeUploadFailure} from "../../src/driver-upload-failure.js";

type Diagnostic = {
  failureId: string;
  stage: "authorizing" | "uploading" | "confirming" | "saving" | "reconciling" | "signature";
  occurredAt: string;
  jobId: string;
  photoId: string;
  planDate: string;
  recordType: string;
  clientVersion: string;
  assetVersion: string;
  attempt: number;
  byteSize: number;
  transferredBytes: number;
  percentage: number | null;
  elapsedMs: number;
  httpStatus: number;
  errorCode: string;
  message: string;
  droppedLogCount: number;
};
const diagnostic: Diagnostic = normalizeUploadFailure({});
void diagnostic;
