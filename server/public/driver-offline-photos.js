(function driverOfflinePhotos(global) {
  "use strict";

  const MAX_EDGE = 2048;
  const MAX_BYTES = 2 * 1024 * 1024;
  const QUALITY_STEPS = [0.86, 0.78, 0.7, 0.62, 0.54, 0.45];
  const activeObjectUrls = new Map();

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode this photo."));
      }, "image/jpeg", quality);
    });
  }

  async function decodeImage(file) {
    if (typeof global.createImageBitmap === "function") {
      try {
        const bitmap = await global.createImageBitmap(file, { imageOrientation: "from-image" });
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
    const sourceUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("This photo could not be decoded."));
        element.src = sourceUrl;
      });
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        draw(context, width, height) {
          context.drawImage(image, 0, 0, width, height);
        },
        close() {}
      };
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  }

  async function sha256(blob) {
    if (!global.crypto?.subtle) throw new Error("Secure photo hashing is not supported by this browser.");
    const digest = await global.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function compress(file) {
    if (!(file instanceof Blob) || !file.size) throw new Error("Choose a valid photo.");
    const decoded = await decodeImage(file);
    try {
      if (!decoded.width || !decoded.height) throw new Error("This photo has invalid dimensions.");
      let scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
      let width = Math.max(1, Math.round(decoded.width * scale));
      let height = Math.max(1, Math.round(decoded.height * scale));
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
          if (blob.size <= MAX_BYTES) {
            return {
              blob,
              mimeType: "image/jpeg",
              byteSize: blob.size,
              width,
              height,
              quality,
              sha256: await sha256(blob)
            };
          }
        }
        if (Math.max(width, height) <= 640) break;
        width = Math.max(1, Math.round(width * 0.82));
        height = Math.max(1, Math.round(height * 0.82));
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
      URL.revokeObjectURL(url);
      activeObjectUrls.delete(photoId);
    }
  }

  function hydrate(record) {
    if (!record) return null;
    if (!record.blob) return { ...record, objectUrl: record.objectReference || "" };
    let objectUrl = activeObjectUrls.get(record.photoId);
    if (!objectUrl) {
      objectUrl = URL.createObjectURL(record.blob);
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
    for (const url of activeObjectUrls.values()) URL.revokeObjectURL(url);
    activeObjectUrls.clear();
  }

  global.DriverOfflinePhotos = {
    MAX_EDGE,
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
