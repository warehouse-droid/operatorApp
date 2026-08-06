(function driverOfflinePhotos(global) {
  "use strict";

  const MAX_EDGE = 2048;
  const SOFT_TARGET_BYTES = 1024 * 1024;
  const MAX_BYTES = 2 * 1024 * 1024;
  const QUALITY_STEPS = [0.86, 0.78, 0.7, 0.62, 0.54, 0.45];
  const activeObjectUrls = new Map();

  function binaryBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return null;
  }

  function readBlobWithFileReader(blob) {
    return new Promise((resolve, reject) => {
      if (typeof global.FileReader !== "function") {
        reject(new Error("FileReader is unavailable."));
        return;
      }
      const reader = new global.FileReader();
      reader.onload = () => {
        const bytes = binaryBuffer(reader.result);
        if (bytes) resolve(bytes);
        else reject(new Error("The selected photo did not contain binary data."));
      };
      reader.onerror = () => reject(reader.error || new Error("The selected photo could not be read."));
      reader.onabort = () => reject(new Error("Reading the selected photo was interrupted."));
      reader.readAsArrayBuffer(blob);
    });
  }

  async function readPhotoBytes(value) {
    const direct = binaryBuffer(value);
    if (direct) return direct.slice(0);
    if (!(value instanceof Blob)) throw new Error("Choose a valid photo.");
    let readError = null;
    if (typeof global.FileReader === "function") {
      try {
        return (await readBlobWithFileReader(value)).slice(0);
      } catch (error) {
        readError = error;
      }
    }
    if (typeof value.arrayBuffer === "function") {
      try {
        return (await value.arrayBuffer()).slice(0);
      } catch (error) {
        readError ||= error;
      }
    }
    const error = new Error("This photo could not be read from the device. Keep the Driver app open and try the photo again.");
    error.cause = readError;
    throw error;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode this photo."));
      }, "image/jpeg", quality);
    });
  }

  function loadHtmlImage(source) {
    return new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("This photo could not be decoded."));
      element.src = source;
    });
  }

  function bytesAsDataUrl(value, mimeType = "image/jpeg") {
    const bytes = new Uint8Array(binaryBuffer(value));
    const chunkSize = 3 * 8192;
    let encoded = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
      let binary = "";
      for (let index = 0; index < chunk.length; index += 1) {
        binary += String.fromCharCode(chunk[index]);
      }
      encoded += global.btoa(binary);
    }
    const safeMimeType = String(mimeType || "image/jpeg").startsWith("image/")
      ? String(mimeType || "image/jpeg")
      : "image/jpeg";
    return `data:${safeMimeType};base64,${encoded}`;
  }

  async function decodeImage(blobBytes, mimeType) {
    const sourceBlob = new Blob([blobBytes], { type: mimeType });
    // WebKit routes blob: reads through its network process. In airplane mode
    // that process can reject a perfectly valid, already-local File with an
    // I/O error. Stay entirely byte-backed whenever the browser reports that
    // it is offline.
    if (global.navigator?.onLine !== false && typeof global.createImageBitmap === "function") {
      try {
        const bitmap = await global.createImageBitmap(sourceBlob, { imageOrientation: "from-image" });
        return {
          width: bitmap.width,
          height: bitmap.height,
          draw(context, width, height) {
            context.drawImage(bitmap, 0, 0, width, height);
          },
          close() {
            bitmap.close?.();
          }
        };
      } catch {
        // Fall through to the HTML image decoder for older Safari releases.
      }
    }
    let image;
    if (global.navigator?.onLine !== false) {
      const sourceUrl = URL.createObjectURL(sourceBlob);
      try {
        image = await loadHtmlImage(sourceUrl);
      } catch {
        image = null;
      } finally {
        URL.revokeObjectURL(sourceUrl);
      }
    }
    if (!image) image = await loadHtmlImage(bytesAsDataUrl(blobBytes, mimeType));
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw(context, width, height) {
        context.drawImage(image, 0, 0, width, height);
      },
      close() {}
    };
  }

  function jpegDimensions(blobBytes) {
    const bytes = new Uint8Array(blobBytes);
    if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const startOfFrame = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
    ]);
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= bytes.length) break;
      const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (startOfFrame.has(marker) && segmentLength >= 7) {
        const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += segmentLength;
    }
    return null;
  }

  async function retainSmallJpeg(blobBytes, mimeType) {
    if (!/^image\/jpe?g$/iu.test(String(mimeType || "")) || blobBytes.byteLength > MAX_BYTES) return null;
    const dimensions = jpegDimensions(blobBytes);
    if (!dimensions || Math.max(dimensions.width, dimensions.height) > MAX_EDGE) return null;
    const blob = new Blob([blobBytes], { type: "image/jpeg" });
    return {
      blob,
      blobBytes,
      mimeType: "image/jpeg",
      byteSize: blobBytes.byteLength,
      width: dimensions.width,
      height: dimensions.height,
      quality: 1,
      sha256: await global.DriverPhotoHash.sha256(blobBytes)
    };
  }

  async function compressedCandidate(blob, width, height, quality) {
    const blobBytes = await readPhotoBytes(blob);
    return {
      blob: new Blob([blobBytes], { type: "image/jpeg" }),
      blobBytes,
      mimeType: "image/jpeg",
      byteSize: blobBytes.byteLength,
      width,
      height,
      quality
    };
  }

  async function compress(file) {
    if (!(file instanceof Blob) || !file.size) throw new Error("Choose a valid photo.");
    const inputBytes = await readPhotoBytes(file);
    const mimeType = String(file.type || "image/jpeg");
    let decoded;
    try {
      decoded = await decodeImage(inputBytes, mimeType);
    } catch (error) {
      const retained = await retainSmallJpeg(inputBytes, mimeType);
      if (retained) return retained;
      throw error;
    }
    try {
      if (!decoded.width || !decoded.height) throw new Error("This photo has invalid dimensions.");
      let scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
      let width = Math.max(1, Math.round(decoded.width * scale));
      let height = Math.max(1, Math.round(decoded.height * scale));
      let hardLimitFallback = null;
      for (let resizeAttempt = 0; resizeAttempt < 9; resizeAttempt += 1) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Photo processing is unavailable in this browser.");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
        decoded.draw(context, width, height);
        for (const quality of QUALITY_STEPS) {
          const blob = await canvasToBlob(canvas, quality);
          const candidate = await compressedCandidate(blob, width, height, quality);
          if (candidate.byteSize <= SOFT_TARGET_BYTES) {
            return {
              ...candidate,
              sha256: await global.DriverPhotoHash.sha256(candidate.blobBytes)
            };
          }
          if (candidate.byteSize <= MAX_BYTES && (!hardLimitFallback || candidate.byteSize < hardLimitFallback.byteSize)) {
            hardLimitFallback = candidate;
          }
        }
        if (Math.max(width, height) <= 640) break;
        width = Math.max(1, Math.round(width * 0.82));
        height = Math.max(1, Math.round(height * 0.82));
      }
      if (hardLimitFallback) {
        return {
          ...hardLimitFallback,
          sha256: await global.DriverPhotoHash.sha256(hardLimitFallback.blobBytes)
        };
      }
      throw new Error("This photo could not be reduced below 2 MB. Try retaking it at a lower camera resolution.");
    } finally {
      decoded.close();
    }
  }

  function revokePhoto(photo) {
    const photoId = typeof photo === "string" ? photo : photo?.photoId;
    const url = photoId ? activeObjectUrls.get(photoId) : null;
    if (url) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      activeObjectUrls.delete(photoId);
    }
  }

  function hydrate(record) {
    if (!record) return null;
    const blobBytes = binaryBuffer(record.blobBytes);
    if (!record.blob && !blobBytes) return { ...record, objectUrl: record.objectReference || "" };
    let objectUrl = activeObjectUrls.get(record.photoId);
    if (!objectUrl) {
      // A data URL is deliberately used for local evidence. Unlike blob: URLs,
      // WebKit can render it after a reload while its network process is offline.
      objectUrl = blobBytes && typeof global.btoa === "function"
        ? bytesAsDataUrl(blobBytes, record.mimeType)
        : URL.createObjectURL(record.blob);
      activeObjectUrls.set(record.photoId, objectUrl);
    }
    return { ...record, objectUrl };
  }

  async function captureAndStore({ file, partitionKey, draftKey, ordinal, recordType, existingPhoto = null }) {
    const compressed = await compress(file);
    const saved = await global.DriverOfflineDB.saveDraftPhoto(partitionKey, draftKey, {
      photoId: global.DriverOfflineDB.createUuid(),
      ordinal: Number(ordinal || 0),
      recordType,
      ...compressed
    }, {
      replacePhotoId: existingPhoto?.photoId || ""
    });
    if (existingPhoto?.photoId && existingPhoto.photoId !== saved.photoId) revokePhoto(existingPhoto);
    return hydrate(saved);
  }

  async function loadDrafts(partitionKey, draftKey) {
    const records = await global.DriverOfflineDB.getDraftPhotos(partitionKey, draftKey);
    return records.map(hydrate);
  }

  function displayUrl(photo) {
    if (!photo) return "";
    if (typeof photo === "string") return photo;
    return photo.objectUrl || photo.objectReference || "";
  }

  function releaseAll() {
    for (const url of activeObjectUrls.values()) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
    activeObjectUrls.clear();
  }

  global.DriverOfflinePhotos = {
    MAX_EDGE,
    SOFT_TARGET_BYTES,
    MAX_BYTES,
    compress,
    captureAndStore,
    hydrate,
    loadDrafts,
    displayUrl,
    revokePhoto,
    releaseAll
  };
})(typeof self !== "undefined" ? self : window);
