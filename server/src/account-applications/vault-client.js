// App-side client for the Cloudflare account vault (server/cloudflare/account-vault).
// The app signs one-scope, short-lived tokens. Card plaintext only ever flows
// browser <-> vault; the app handles references, receipts and lifecycle calls.
import crypto from 'node:crypto';
import { AccountApplicationError } from '../../public/account-applications/domain.js';

const AUDIENCE = 'mbbs-account-vault';
const REQUEST_TIMEOUT_MS = 20000;

const b64url = (value) => Buffer.from(value).toString('base64url');
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');

export function createVaultClient({ settings, fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const current = () => {
    const value = typeof settings === 'function' ? settings() : settings;
    return { url: String(value?.vaultUrl || '').replace(/\/+$/u, ''), secret: String(value?.vaultTokenSecret || '') };
  };
  const configured = () => { const { url, secret } = current(); return Boolean(url) && secret.length >= 32; };
  function requireConfigured() {
    if (!configured()) throw new AccountApplicationError('The secure document vault is not configured yet. Contact the office.', 503, 'ACCOUNT_VAULT_NOT_CONFIGURED');
    return current();
  }
  function token(scope, { sub = '', ref = '', ttlSeconds = 60 } = {}) {
    const { secret } = requireConfigured();
    const iat = Math.floor(now() / 1000);
    const claims = { aud: AUDIENCE, scope, iat, exp: iat + ttlSeconds, jti: crypto.randomUUID(), ...(sub ? { sub } : {}), ...(ref ? { ref } : {}) };
    const unsigned = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    return { token: `${unsigned}.${hmac(secret, unsigned)}`, expiresAt: new Date((iat + ttlSeconds) * 1000).toISOString() };
  }
  async function call(method, path, scope, { sub, ref, body, headers = {}, raw = false, allowNotFound = false } = {}) {
    const { url } = requireConfigured();
    let response;
    try {
      response = await fetchImpl(`${url}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token(scope, { sub, ref }).token}`, ...headers }, body });
    } catch {
      throw new AccountApplicationError('The secure document vault could not be reached. Please try again.', 502, 'ACCOUNT_VAULT_UNAVAILABLE');
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const status = response.status >= 500 ? 502 : response.status === 401 ? 502 : response.status;
      throw new AccountApplicationError(payload.error || 'The secure document vault rejected the request.', status, payload.code || 'ACCOUNT_VAULT_FAILED');
    }
    return raw ? response : response.json();
  }
  return {
    configured,
    publicOrigin() { const { url } = current(); try { return url ? new URL(url).origin : ''; } catch { return ''; } },
    cardRef(applicationId) { return hmac(requireConfigured().secret, `account-vault:card-ref:v1:${applicationId}`).slice(0, 32); },
    receipt(applicationId, summary) {
      return hmac(requireConfigured().secret, ['account-vault:receipt:v1', applicationId, summary.ref, summary.brand, summary.last4,
        summary.expMonth, summary.expYear, summary.hasCvv ? 1 : 0].join(':'));
    },
    verifyReceipt(applicationId, summary) {
      const expected = Buffer.from(this.receipt(applicationId, summary));
      const provided = Buffer.from(String(summary.receipt || ''));
      return summary.ref === this.cardRef(applicationId) && expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
    },
    cardPutTicket(applicationId) {
      const { url } = requireConfigured();
      return { url: `${url}/v1/cards`, ...token('card.put', { sub: applicationId, ttlSeconds: 600 }) };
    },
    cardRevealTicket(applicationId, ref) {
      const { url } = requireConfigured();
      return { url: `${url}/v1/cards/${encodeURIComponent(ref)}`, ...token('card.reveal', { sub: applicationId, ref, ttlSeconds: 60 }) };
    },
    async commitCard(applicationId, ref) {
      return call('POST', `/v1/cards/${encodeURIComponent(ref)}/commit`, 'card.commit', { sub: applicationId, ref });
    },
    async purgeCvv(ref) { return call('DELETE', `/v1/cards/${encodeURIComponent(ref)}/cvv`, 'card.purge-cvv', { ref, allowNotFound: true }); },
    async deleteCard(ref) { return call('DELETE', `/v1/cards/${encodeURIComponent(ref)}`, 'card.delete', { ref, allowNotFound: true }); },
    async putDoc(ref, bytes, mimeType) {
      return call('PUT', `/v1/docs/${encodeURIComponent(ref)}`, 'doc.put', { ref, body: bytes, headers: { 'content-type': mimeType } });
    },
    async getDoc(ref) {
      const response = await call('GET', `/v1/docs/${encodeURIComponent(ref)}`, 'doc.get', { ref, raw: true });
      return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'application/octet-stream' };
    },
    async deleteDoc(ref) { return call('DELETE', `/v1/docs/${encodeURIComponent(ref)}`, 'doc.delete', { ref, allowNotFound: true }); }
  };
}
