// Generic customer-link credentials: a random 43-character base64url token,
// looked up only by its SHA-256 hash, and stored AES-256-GCM encrypted (bound to
// a caller-supplied context) so staff can copy the same link again.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function decodeKey(text, label) {
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== 32 || key.toString('base64') !== text.trim()) throw new Error(`The ${label} key is invalid.`);
  return key;
}

export async function loadOrCreateKeyFile(filename, label = 'link') {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try { return decodeKey(await fs.readFile(filename, 'utf8'), label); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const generated = crypto.randomBytes(32);
  try { await fs.writeFile(filename, generated.toString('base64') + '\n', { flag: 'wx', mode: 0o600 }); return generated; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return decodeKey(await fs.readFile(filename, 'utf8'), label);
}

export function isLinkToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

export function hashToken(token, invalid) {
  if (!isLinkToken(token)) throw invalid();
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createCredential(key, context, invalid) {
  const token = crypto.randomBytes(32).toString('base64url'), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { token, hash: hashToken(token, invalid), encrypted: { version: 1, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') } };
}

export function decryptCredential(key, context, encrypted, invalid) {
  if (encrypted?.version !== 1) throw new Error('Unsupported link key record.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const token = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8');
  hashToken(token, invalid);
  return token;
}
