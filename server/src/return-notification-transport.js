import { normalizeAccountEmail } from './account-email.js';
import { returnNotificationSettings } from './return-notification-settings.js';

function deliveryError(channel, deliveryStatus) {
  const message = deliveryStatus === 'failed'
    ? `${channel === 'sms' ? 'Telnyx' : 'Email service'} rejected the message. Check the recipient and service settings, then try again.`
    : 'Delivery outcome is unknown. Ask an administrator to check the email/Telnyx logs before sending again.';
  return Object.assign(new Error(message), { status: 502, deliveryStatus });
}

function smsProviderId(data) {
  if (!data?.id) { throw deliveryError('sms', 'uncertain'); }
  if (data.errors?.length || data.to?.some(to => ['sending_failed', 'delivery_failed'].includes(to.status))) {
    throw deliveryError('sms', 'failed');
  }
  return { providerId: String(data.id) };
}

function emailFailureStatus(error) {
  const refused = error.deliveryStatus === 'failed' || Number(error.responseCode) >= 400
    || error.command === 'CONN' || ['ECONNECTION', 'ECONNREFUSED', 'EDNS'].includes(error.code);
  return refused ? 'failed' : 'uncertain';
}

export function createReturnNotificationTransport({ settings = returnNotificationSettings, env = process.env,
  fetchImpl = (url, options) => fetch(url, options), loadTransport = async options => {
    const { default: nodemailer } = await import('nodemailer');
    return nodemailer.createTransport(options);
  } } = {}) {
  const emailConfigured = () => Boolean(env.BOSS_SMTP_HOST && env.BOSS_SMTP_USER && env.BOSS_SMTP_PASSWORD);
  async function checkReady(channel) {
    if (channel === 'sms') {
      const credentials = await settings.read();
      if (!credentials.apiKey || !credentials.fromNumber) {
        throw Object.assign(new Error('Ask an administrator to configure the Telnyx API key and sender number in Return settings.'), { status: 503 });
      }
      return credentials;
    }
    if (!emailConfigured() || ![465, 587].includes(Number(env.BOSS_SMTP_PORT || 587))) {
      throw Object.assign(new Error('Return email is unavailable. Ask an administrator to configure the existing SMTP email service with TLS.'), { status: 503 });
    }
    normalizeAccountEmail(env.BOSS_SMTP_FROM || 'warehouse@mrbininc.com');
    return null;
  }
  async function sendSms(message, credentials) {
    let response;
    try {
      response = await fetchImpl('https://api.telnyx.com/v2/messages', {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: credentials.fromNumber, to: message.recipient, text: message.text, type: 'SMS' }),
        signal: AbortSignal.timeout(20000), redirect: 'error'
      });
    } catch { throw deliveryError('sms', 'uncertain'); }
    if (!response.ok) {
      const refused = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw deliveryError('sms', refused ? 'failed' : 'uncertain');
    }
    let data;
    try { data = (await response.json()).data; } catch { throw deliveryError('sms', 'uncertain'); }
    return smsProviderId(data);
  }
  async function sendEmail(message) {
    let transport;
    try {
      const port = Number(env.BOSS_SMTP_PORT || 587);
      transport = await loadTransport({ host: env.BOSS_SMTP_HOST, port, secure: port === 465, requireTLS: true,
        auth: { user: env.BOSS_SMTP_USER, pass: env.BOSS_SMTP_PASSWORD },
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
        disableFileAccess: true, disableUrlAccess: true, tls: { minVersion: 'TLSv1.2' } });
      const result = await transport.sendMail({
        from: { name: 'MBBS', address: normalizeAccountEmail(env.BOSS_SMTP_FROM || 'warehouse@mrbininc.com') },
        to: message.recipient, subject: message.subject, text: message.text,
        disableFileAccess: true, disableUrlAccess: true, headers: { 'Auto-Submitted': 'auto-generated' }
      });
      if (!result.accepted?.length) { throw deliveryError('email', 'failed'); }
      return { providerId: String(result.messageId || '') };
    } catch (error) {
      throw deliveryError('email', emailFailureStatus(error));
    } finally { transport?.close?.(); }
  }
  async function send(message) {
    const credentials = await checkReady(message.channel);
    return message.channel === 'sms' ? sendSms(message, credentials) : sendEmail(message);
  }
  return { checkReady, send, emailConfigured };
}

export const returnNotificationTransport = createReturnNotificationTransport();
