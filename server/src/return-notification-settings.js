import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AAD = Buffer.from('mbbs:return-notification:telnyx:v1');
const defaultDirectory = fileURLToPath(new URL('../data', import.meta.url));

function publicSettings(state) {
  return { hasApiKey: Boolean(state.encryptedKey), fromNumber: state.fromNumber || '',
    configured: Boolean(state.encryptedKey && state.fromNumber) };
}

function validateSettings(input) {
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string'
    || input.apiKey.length > 512 || /[\x00-\x20\x7f]/.test(input.apiKey))) {
    throw Object.assign(new Error('Enter a valid Telnyx API key without spaces or line breaks.'), { status: 400 });
  }
  if (input.fromNumber !== undefined && (typeof input.fromNumber !== 'string'
    || (input.fromNumber !== '' && !/^\+[1-9]\d{7,14}$/.test(input.fromNumber)))) {
    throw Object.assign(new Error('Enter your Telnyx sender number with +country code, for example +14165550123.'), { status: 400 });
  }
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') {
    throw Object.assign(new Error('Invalid API key removal option.'), { status: 400 });
  }
}

function encrypt(apiKey, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

function decrypt(encrypted, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8');
}

export function createReturnNotificationSettings({ directory = defaultDirectory } = {}) {
  const filename = path.join(directory, 'return-notification-settings.json');
  const keyfile = path.join(directory, '.return-notification-key');
  let saving = Promise.resolve();
  async function state() {
    try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') { return {}; }
      throw new Error('Unable to read return notification settings. Contact an administrator.');
    }
  }
  async function masterKey(create = false) {
    if (create) {
      try { await fs.writeFile(keyfile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') { throw error; } }
    }
    return fs.readFile(keyfile);
  }
  async function read() {
    try {
      const saved = await state();
      return { fromNumber: saved.fromNumber || '', apiKey: saved.encryptedKey ? decrypt(saved.encryptedKey, await masterKey()) : '' };
    } catch {
      throw Object.assign(new Error('Unable to read Telnyx credentials. Ask an administrator to save the API key again.'), { status: 503 });
    }
  }
  async function persist(input) {
    validateSettings(input);
    const saved = await state();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (input.fromNumber !== undefined) { saved.fromNumber = input.fromNumber; }
    if (input.clearApiKey) { delete saved.encryptedKey; }
    else if (input.apiKey) { saved.encryptedKey = encrypt(input.apiKey, await masterKey(true)); }
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
    return publicSettings(saved);
  }
  function save(input = {}) {
    const pending = saving.then(() => persist(input));
    saving = pending.then(() => undefined, () => undefined);
    return pending;
  }
  return { read, save, public: async () => publicSettings(await state()) };
}

export const returnNotificationSettings = createReturnNotificationSettings();
