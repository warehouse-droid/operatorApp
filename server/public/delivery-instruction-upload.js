(function deliveryInstructionUploadModule(global) {
  "use strict";

  const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
  const JPEG_QUALITY = 0.72;
  const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
  const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
  const EXTENSION_TYPES = Object.freeze({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm"
  });

  function fileType(file = {}) {
    const declared = String(file.type || "").trim().toLowerCase();
    if (declared) return declared;
    const extension = String(file.name || "").split(".").pop()?.toLowerCase() || "";
    return EXTENSION_TYPES[extension] || "";
  }

  function outputDimensions(width, height) {
    const sourceWidth = Math.max(1, Number(width) || 1);
    const sourceHeight = Math.max(1, Number(height) || 1);
    const landscape = sourceWidth >= sourceHeight;
    const maxWidth = landscape ? 1280 : 720;
    const maxHeight = landscape ? 720 : 1280;
    const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale))
    };
  }

  function outputFileName(name) {
    const source = String(name || "delivery-instruction-image").replace(/\.[^.]+$/u, "");
    return `${source.replace(/-720p$/iu, "") || "delivery-instruction-image"}-720p.jpg`;
  }

  async function decodeImage(file) {
    if (typeof global.createImageBitmap === "function") {
      try {
        const bitmap = await global.createImageBitmap(file, { imageOrientation: "from-image" });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
      } catch {
        try {
          const bitmap = await global.createImageBitmap(file);
          return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
        } catch {
          // The HTML image decoder below covers browsers without ImageBitmap support for this format.
        }
      }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url)
      });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Could not decode ${file.name || "this image"}. Convert it to JPEG, PNG, or WebP and try again.`));
      };
      image.src = url;
    });
  }

  function canvasJpeg(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob?.size) resolve(blob);
        else reject(new Error("The image could not be compressed. Try a different image."));
      }, "image/jpeg", JPEG_QUALITY);
    });
  }

  async function compressImage(file) {
    const decoded = await decodeImage(file);
    try {
      const dimensions = outputDimensions(decoded.width, decoded.height);
      const canvas = document.createElement("canvas");
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser cannot prepare delivery-instruction images.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      const blob = await canvasJpeg(canvas);
      return new File([blob], outputFileName(file.name), {
        type: "image/jpeg",
        lastModified: Date.now()
      });
    } finally {
      decoded.close?.();
    }
  }

  async function prepareFiles(fileList) {
    const sourceFiles = [...(fileList || [])];
    const prepared = [];
    for (const file of sourceFiles) {
      const type = fileType(file);
      if (!IMAGE_TYPES.has(type) && !VIDEO_TYPES.has(type)) {
        throw new Error(`Unsupported delivery-instruction file: ${file.name || "unnamed file"}.`);
      }
      if (!Number.isFinite(file.size) || file.size < 1 || file.size > MAX_SOURCE_BYTES) {
        throw new Error(`${file.name || "This file"} must be no larger than 25 MB.`);
      }
      if (IMAGE_TYPES.has(type)) {
        prepared.push(await compressImage(file));
      } else if (file.type === type) {
        prepared.push(file);
      } else {
        prepared.push(new File([file], file.name || "delivery-instruction-video", {
          type,
          lastModified: file.lastModified || Date.now()
        }));
      }
    }
    return prepared;
  }

  function isFileDrag(event) {
    return [...(event?.dataTransfer?.types || [])].includes("Files");
  }

  global.DeliveryInstructionUpload = Object.freeze({
    JPEG_QUALITY,
    MAX_SOURCE_BYTES,
    compressImage,
    fileType,
    isFileDrag,
    outputDimensions,
    outputFileName,
    prepareFiles
  });
})(window);
