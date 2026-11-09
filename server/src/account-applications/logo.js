import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { AccountApplicationError } from '../../public/account-applications/domain.js';

export const MAX_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024;
const hasPrefix = (bytes, prefix) => prefix.every((value, index) => bytes[index] === value);

// Accept only PNG, JPEG or WebP (checked by magic bytes before decoding), then
// re-encode as a bounded PNG so the stored logo is always a clean raster image.
export async function normalizeLogo(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!bytes.length) throw new AccountApplicationError('Choose a logo image to upload.', 400, 'ACCOUNT_APPLICATION_LOGO_EMPTY');
  if (bytes.length > MAX_LOGO_UPLOAD_BYTES) throw new AccountApplicationError('The logo must be 5 MB or smaller.', 413, 'ACCOUNT_APPLICATION_LOGO_TOO_LARGE');
  const png = hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47]), jpeg = hasPrefix(bytes, [0xff, 0xd8, 0xff]);
  const webp = hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!png && !jpeg && !webp) throw new AccountApplicationError('Upload the logo as a PNG, JPEG or WebP image.', 415, 'ACCOUNT_APPLICATION_LOGO_TYPE');
  try {
    const { data, info } = await sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate()
      .resize(800, 300, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height, sha256: createHash('sha256').update(data).digest('hex') };
  } catch {
    throw new AccountApplicationError('This logo image could not be read. Try a PNG or JPEG file.', 422, 'ACCOUNT_APPLICATION_LOGO_INVALID');
  }
}
