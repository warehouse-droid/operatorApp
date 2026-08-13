import sharp from "sharp";

import {
  DELIVERY_INSTRUCTION_IMAGE_TYPES,
  DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES,
  deliveryInstructionUploadReferenceMatches,
  normalizeDeliveryInstructionMedia
} from "./delivery-instruction-domain.js";
import { createPhotoReadToken, isJpegEvidenceBytes } from "./photo-upload.js";

const DELIVERY_INSTRUCTION_OBJECT_TIMEOUT_MS = 15000;
const MAX_IMAGE_PIXELS = 50_000_000;

function mediaValidationError(message, status = 422, code = "DELIVERY_INSTRUCTION_IMAGE_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function hasPrefix(bytes, prefix) {
  return prefix.every((value, index) => bytes[index] === value);
}

function validPngEnvelope(bytes) {
  return bytes.length >= 20
    && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    && hasPrefix(bytes.subarray(bytes.length - 12), [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44]);
}

function validWebpEnvelope(bytes) {
  if (bytes.length < 20
      || !hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46])
      || !hasPrefix(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return false;
  const declaredSize = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  return (declaredSize >>> 0) + 8 === bytes.length;
}

function validHeifEnvelope(bytes) {
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") return false;
  const brands = String.fromCharCode(...bytes.subarray(8, Math.min(bytes.length, 64)));
  return /(?:heic|heix|hevc|hevx|heim|heis|mif1|msf1)/u.test(brands);
}

function assertImageEnvelope(bytes, mimeType) {
  if (mimeType === "image/jpeg" && !isJpegEvidenceBytes(bytes)) {
    throw mediaValidationError("The uploaded JPEG is incomplete or malformed. Upload it again.");
  }
  if (mimeType === "image/png" && !validPngEnvelope(bytes)) {
    throw mediaValidationError("The uploaded PNG is incomplete or malformed. Upload it again.");
  }
  if (mimeType === "image/webp" && !validWebpEnvelope(bytes)) {
    throw mediaValidationError("The uploaded WebP image is incomplete or malformed. Upload it again.");
  }
  if (["image/heic", "image/heif"].includes(mimeType) && !validHeifEnvelope(bytes)) {
    throw mediaValidationError("The uploaded HEIC/HEIF image is incomplete or malformed. Upload it again.");
  }
}

export async function validateDeliveryInstructionImageBytes(value, {
  mimeType,
  declaredByteSize
} = {}) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  const normalizedType = String(mimeType || "").trim().toLowerCase();
  const expectedSize = Number(declaredByteSize);
  if (!DELIVERY_INSTRUCTION_IMAGE_TYPES.includes(normalizedType)) {
    throw mediaValidationError("The uploaded file is not a supported delivery-instruction image.", 415, "DELIVERY_INSTRUCTION_MEDIA_TYPE");
  }
  if (!bytes.length || bytes.length > DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES || bytes.length !== expectedSize) {
    throw mediaValidationError("The uploaded image size does not match the completed upload.");
  }
  assertImageEnvelope(bytes, normalizedType);
  try {
    const result = await sharp(Buffer.from(bytes), {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true
    }).raw().toBuffer({ resolveWithObject: true });
    if (!result.data.length || !result.info.width || !result.info.height) throw new Error("No decoded pixels");
    return {
      byteSize: bytes.length,
      width: result.info.width,
      height: result.info.height,
      mimeType: normalizedType
    };
  } catch {
    throw mediaValidationError("The uploaded image cannot be decoded completely. Upload it again.");
  }
}

export async function validateDeliveryInstructionUploadedObject(input = {}, {
  actor,
  fetchImpl = globalThis.fetch,
  createReadTicket = createPhotoReadToken
} = {}) {
  const media = normalizeDeliveryInstructionMedia(input);
  if (media.mediaKind !== "image") return { skipped: true, mediaKind: media.mediaKind };
  if (!deliveryInstructionUploadReferenceMatches(input.objectReference, input.uploadId)) {
    throw mediaValidationError("The uploaded delivery-instruction object does not match this upload ticket.", 400, "DELIVERY_INSTRUCTION_UPLOAD_REFERENCE");
  }
  const ticket = createReadTicket({ actor, key: input.objectReference });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_INSTRUCTION_OBJECT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(ticket.objectUrl, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${ticket.token}` }
    });
    if (!response.ok) {
      throw mediaValidationError("The uploaded image could not be verified. Upload it again.", 502, "DELIVERY_INSTRUCTION_IMAGE_VERIFY_FAILED");
    }
    const responseType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (responseType && responseType !== "application/octet-stream" && responseType !== media.mimeType) {
      throw mediaValidationError("The uploaded image type does not match the selected file.");
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength !== media.byteSize) {
      throw mediaValidationError("The uploaded image size does not match the selected file.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return validateDeliveryInstructionImageBytes(bytes, {
      mimeType: media.mimeType,
      declaredByteSize: media.byteSize
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw mediaValidationError("The uploaded image verification timed out. Upload it again.", 504, "DELIVERY_INSTRUCTION_IMAGE_VERIFY_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
