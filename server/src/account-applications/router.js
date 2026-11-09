import express from 'express';
import { createPublicRateLimiter } from '../mbr/router.js';
import { AccountApplicationError } from '../../public/account-applications/domain.js';

const LINK_HEADER = 'x-account-application-link';
const IP_PATTERN = /^[0-9A-Fa-f:.]{3,45}$/u;

// The app runs behind cloudflared without `trust proxy`, so req.ip is the proxy.
export function clientIp(req) {
  const forwarded = String(req.get('cf-connecting-ip') || '').trim();
  return IP_PATTERN.test(forwarded) ? forwarded : req.ip || '';
}

function sameOrigin(req, _res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  const protocol = req.get('x-forwarded-proto')?.split(',')[0].trim() || req.protocol;
  if (origin !== `${protocol}://${req.get('host')}`) {
    return next(new AccountApplicationError('Open your application link directly to submit it.', 403, 'ACCOUNT_APPLICATION_ORIGIN_INVALID'));
  }
  next();
}

function pdfResponse(res, pdf) {
  return res.type('application/pdf').set('Content-Disposition', `attachment; filename="${pdf.filename}"`).send(pdf.bytes);
}

function imageResponse(res, document) {
  return res.type(document.contentType).set({ 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox" })
    .send(document.bytes);
}

const pageQuery = (req) => ({
  search: typeof req.query.search === 'string' ? req.query.search : '',
  status: typeof req.query.status === 'string' ? req.query.status : '',
  company: typeof req.query.company === 'string' ? req.query.company : '',
  offset: req.query.offset === undefined ? 0 : Number(req.query.offset)
});

export function createAccountApplicationRouter({ repo, authenticate, enabled = () => true, logger = console }) {
  const router = express.Router();
  const wrap = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    if (!enabled()) return res.status(503).json({ error: 'Account applications are not enabled.', code: 'ACCOUNT_APPLICATIONS_DISABLED' });
    next();
  });

  const publicRouter = express.Router();
  publicRouter.use(createPublicRateLimiter({ limit: 120, key: clientIp }));
  publicRouter.use((req, _res, next) => {
    req.applicationToken = req.get(LINK_HEADER);
    if (typeof req.applicationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(req.applicationToken)) {
      return next(new AccountApplicationError('This application link is unavailable. Please ask your Mr. Bin contact for a new link.', 404, 'ACCOUNT_APPLICATION_LINK_INVALID'));
    }
    next();
  });
  const perLink = (limit) => createPublicRateLimiter({ limit, key: (req) => `${clientIp(req)}:${req.applicationToken}` });
  publicRouter.get('/application', wrap(async (req, res) => res.json(await repo.publicView(req.applicationToken))));
  publicRouter.get('/pdf', perLink(20), wrap(async (req, res) => pdfResponse(res, await repo.publicPdf(req.applicationToken))));
  publicRouter.post('/uploads', sameOrigin, perLink(20), express.raw({ type: () => true, limit: '12mb' }), wrap(async (req, res) => {
    const mimeType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) throw new AccountApplicationError('Choose an image to upload.', 400, 'ACCOUNT_APPLICATION_UPLOAD_EMPTY');
    res.status(201).json(await repo.publicUpload(req.applicationToken, { kind: String(req.query.kind || ''), mimeType, bytes }));
  }));
  publicRouter.delete('/uploads/:uploadId', sameOrigin, perLink(30), wrap(async (req, res) => res.json(await repo.publicDeleteUpload(req.applicationToken, req.params.uploadId))));
  publicRouter.post('/card-ticket', sameOrigin, perLink(10), wrap(async (req, res) => res.json(await repo.publicCardTicket(req.applicationToken))));
  publicRouter.post('/submit', sameOrigin, perLink(8), express.json({ limit: '1mb' }), wrap(async (req, res) => res.json(
    await repo.publicSubmit(req.applicationToken, req.body, { ip: clientIp(req), userAgent: req.get('user-agent') }))));
  router.use('/public', publicRouter);
  // Company logos are public branding (customer form letterhead); cache briefly, versioned by ?v=<hash>.
  router.get('/logos/:company', createPublicRateLimiter({ limit: 240, key: clientIp }), wrap(async (req, res) => {
    const logo = await repo.logo(req.params.company);
    res.set({ 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'none'; sandbox" }).type(logo.contentType).send(logo.bytes);
  }));

  router.use(authenticate);
  router.use(express.json({ limit: '64kb' }));
  // Staff who create applications (Sales, MBT front desk, MBR sales, Field sales, Admin).
  router.get('/profiles', wrap(async (req, res) => res.json(await repo.profiles(req.operator))));
  router.get('/applications', wrap(async (req, res) => res.json(await repo.list(req.operator, pageQuery(req)))));
  router.post('/applications', wrap(async (req, res) => res.status(201).json(await repo.create(req.operator, req.body))));
  router.get('/applications/:id', wrap(async (req, res) => res.json(await repo.get(req.operator, req.params.id))));
  router.post('/applications/:id/link', wrap(async (req, res) => res.json(await repo.link(req.operator, req.params.id, { regenerate: req.body?.regenerate === true }))));
  router.post('/applications/:id/extend', wrap(async (req, res) => res.json(await repo.extend(req.operator, req.params.id, req.body))));
  router.post('/applications/:id/cancel', wrap(async (req, res) => res.json(await repo.cancel(req.operator, req.params.id))));
  router.get('/applications/:id/pdf', wrap(async (req, res) => pdfResponse(res, await repo.pdf(req.operator, req.params.id))));
  router.get('/applications/:id/documents/:uploadId', wrap(async (req, res) => imageResponse(res, await repo.documentFor(req.operator, req.params.id, req.params.uploadId))));
  // Accounting review (card and driver's licence are visible here only).
  router.get('/review/summary', wrap(async (req, res) => res.json(await repo.submittedCount(req.operator))));
  router.get('/review/options', wrap(async (req, res) => res.json(await repo.reviewOptions(req.operator))));
  router.get('/review', wrap(async (req, res) => res.json(await repo.list(req.operator, { ...pageQuery(req), review: true }))));
  router.get('/review/:id', wrap(async (req, res) => res.json(await repo.reviewGet(req.operator, req.params.id))));
  router.get('/review/:id/pdf', wrap(async (req, res) => pdfResponse(res, await repo.pdf(req.operator, req.params.id))));
  router.get('/review/:id/documents/:uploadId', wrap(async (req, res) => imageResponse(res,
    await repo.documentFor(req.operator, req.params.id, req.params.uploadId, { review: true }))));
  router.get('/review/:id/netsuite-matches', wrap(async (req, res) => res.json(await repo.matches(req.operator, req.params.id))));
  router.post('/review/:id/card/reveal', wrap(async (req, res) => res.json(await repo.cardReveal(req.operator, req.params.id))));
  router.post('/review/:id/card/charged', wrap(async (req, res) => res.json(await repo.cardCharged(req.operator, req.params.id))));
  router.delete('/review/:id/card', wrap(async (req, res) => res.json(await repo.cardDelete(req.operator, req.params.id))));
  router.post('/review/:id/approve', wrap(async (req, res) => res.json(await repo.approve(req.operator, req.params.id, req.body))));
  router.post('/review/:id/link-existing', wrap(async (req, res) => res.json(await repo.linkExisting(req.operator, req.params.id, req.body))));
  router.post('/review/:id/reject', wrap(async (req, res) => res.json(await repo.reject(req.operator, req.params.id, req.body))));
  router.get('/settings', wrap(async (req, res) => res.json(await repo.getSettings(req.operator))));
  router.put('/settings', wrap(async (req, res) => res.json(await repo.updateSettings(req.operator, req.body))));
  router.put('/settings/logos/:company', express.raw({ type: () => true, limit: '6mb' }), wrap(async (req, res) => res.json(
    await repo.putLogo(req.operator, req.params.company, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)))));
  router.delete('/settings/logos/:company', wrap(async (req, res) => res.json(await repo.deleteLogo(req.operator, req.params.company))));

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const known = error instanceof AccountApplicationError || (error?.code && String(error.code).startsWith('MBR_') && error.status < 500);
    const status = Number(error?.status) || (error?.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500 && !known) logger.error('[Account applications] Request failed.', { code: error?.code || 'ACCOUNT_APPLICATION_INTERNAL' });
    res.status(status).json({
      error: known || status < 500 ? (status === 413 ? 'This upload is too large.' : error.message) : 'Could not complete this request. Please try again.',
      code: known ? error.code : status === 413 ? 'ACCOUNT_APPLICATION_TOO_LARGE' : status === 429 ? 'ACCOUNT_APPLICATION_RATE_LIMITED' : 'ACCOUNT_APPLICATION_ERROR'
    });
  });
  return router;
}
