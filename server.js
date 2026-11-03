import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR, one, all, run } from './db.js';
import { TYPES, checklist, ensurePatient, ingestFile, reprocess, scheduleReply, statusMessage, recordOutgoing, logIncoming, notify, onChange } from './pipeline.js';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
const PUB = path.resolve('public');

// ---------- auth: named agent logins, stateless signed cookie ----------
const AGENTS = Object.fromEntries((process.env.AGENTS || '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)]));
if (!Object.keys(AGENTS).length) { console.error('Set AGENTS=user:password in .env'); process.exit(1); }
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const hmac = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const same = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

function makeToken(user, ttl = 12 * 3600e3) {
  const v = Buffer.from(JSON.stringify({ u: user, e: Date.now() + ttl })).toString('base64url');
  return `${v}.${hmac(v)}`;
}
function readToken(t = '') {
  const [v, s] = t.split('.');
  if (!v || !s || !same(s, hmac(v))) return null;
  const { u, e } = JSON.parse(Buffer.from(v, 'base64url'));
  return e > Date.now() && u in AGENTS ? u : null;
}
const cookie = (req, name) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

const fails = new Map(); // ponytail: in-memory login throttle, per process; fine for one instance
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const key = req.ip, f = fails.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60e3) Object.assign(f, { n: 0, t: Date.now() });
  if (f.n >= 10) return res.redirect('/login?e=locked');
  const { user = '', password = '' } = req.body;
  if (!(user in AGENTS) || !same(password, AGENTS[user])) { f.n++; fails.set(key, f); return res.redirect('/login?e=1'); }
  fails.delete(key);
  res.setHeader('Set-Cookie', `sid=${makeToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${req.secure ? '; Secure' : ''}`);
  run(`INSERT INTO audit(user, action) VALUES(?, 'login')`, user);
  res.redirect('/');
});
app.post('/logout', (req, res) => { res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); res.redirect('/login'); });
app.get('/login', (req, res) => res.sendFile(path.join(PUB, 'login.html')));
app.get('/health', (req, res) => res.send('ok'));

// ---------- Twilio WhatsApp webhook ----------
const TW = () => ({ sid: process.env.TWILIO_ACCOUNT_SID, tok: process.env.TWILIO_AUTH_TOKEN });
function validTwilio(req) {
  const { tok } = TW();
  if (!tok) return false;
  const url = (process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`) + req.originalUrl;
  const data = url + Object.keys(req.body).sort().map((k) => k + req.body[k]).join('');
  const want = crypto.createHmac('sha1', tok).update(data).digest('base64');
  return same(req.get('x-twilio-signature') || '', want);
}
async function download(url) {
  const { sid, tok } = TW();
  const r = await fetch(url, { headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') } });
  if (!r.ok) throw new Error(`media download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
// REPLY_MODE=twiml (default): reply inside the webhook response. Twilio trial / sandbox senders reject
// free-form REST sends (error 21654) but accept TwiML replies. REPLY_MODE=rest: async REST send after a quiet period.
const TWIML = (process.env.REPLY_MODE || 'twiml') === 'twiml';
const latestHook = new Map(); // phone -> id of the newest webhook, so a burst of photos gets one reply
let hookSeq = 0;
const xml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

app.post('/webhook/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  if (!validTwilio(req)) { console.warn('rejected webhook: bad signature'); return res.status(403).end(); }
  const empty = () => res.type('text/xml').send('<Response/>');
  const b = req.body, phone = String(b.From || '').replace(/^whatsapp:/, '');
  const n = Number(b.NumMedia || 0);
  if (!phone || (!n && !b.Body)) return empty(); // reactions, read receipts etc.
  if (!TWIML) empty(); // answer now, work in the background
  const me = ++hookSeq;
  latestHook.set(phone, me);

  ensurePatient(phone, b.ProfileName);
  if (b.To) run(`UPDATE patients SET wa_number = ? WHERE phone = ?`, String(b.To).replace(/^whatsapp:/, ''), phone);
  if (b.Body) logIncoming(phone, b.Body);
  if (n && !b.Body) logIncoming(phone, `[${n} attachment${n > 1 ? 's' : ''}]`);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    try { jobs.push(ingestFile({ phone, buf: await download(b[`MediaUrl${i}`]), mime: b[`MediaContentType${i}`], profileName: b.ProfileName })); }
    catch (e) { console.error(e); }
  }
  if (!TWIML) return n || scheduleReply(phone, 1000);

  // Twilio gives up after 15 s; wait up to 11 s for this message's files, then answer with the status.
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 11000))]);
  if (latestHook.get(phone) !== me) return empty(); // a newer message from this patient will answer
  latestHook.delete(phone);
  const busy = one(`SELECT count(*) n FROM files WHERE phone = ? AND status = 'processing'`, phone).n;
  let body = statusMessage(phone);
  if (busy) body += `\n\n🔄 Still reading ${busy} file${busy > 1 ? 's' : ''}. Send "status" in a minute for an update.`;
  recordOutgoing(phone, body, 'sent (webhook reply)');
  res.type('text/xml').send(`<Response><Message>${xml(body.slice(0, 1600))}</Message></Response>`);
});

// ---------- everything below needs a logged-in agent ----------
app.use((req, res, next) => {
  req.user = readToken(cookie(req, 'sid'));
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login required' });
  res.redirect('/login');
});
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get('/api/me', (req, res) => res.json({ user: req.user, types: TYPES, canPush: !TWIML }));

const audit = (req, action, phone, detail = null) => run(`INSERT INTO audit(user, action, phone, detail) VALUES(?,?,?,?)`, req.user, action, phone, detail);
const patientById = (id) => one(`SELECT * FROM patients WHERE id = ?`, Number(id));
const mask = (p) => p.length > 6 ? p.slice(0, 3) + ' •••• ' + p.slice(-3) : '••••';

app.get('/api/cases', (req, res) => {
  const rows = all(`SELECT p.*,
      (SELECT count(*) FROM documents d WHERE d.phone = p.phone AND d.status IN ('unreadable','wrong_patient')) +
      (SELECT count(*) FROM files f WHERE f.phone = p.phone AND f.status IN ('error','unsupported')) AS attention,
      (SELECT count(*) FROM files f WHERE f.phone = p.phone AND f.status = 'processing') AS processing
    FROM patients p ORDER BY p.updated_at DESC`);
  res.json(rows.map((p) => ({
    id: p.id, name: p.name, profile_name: p.profile_name, phone: mask(p.phone), updated_at: p.updated_at,
    attention: p.attention, processing: p.processing, checklist: checklist(p.phone),
  })));
});

app.get('/api/cases/:id', (req, res) => {
  const p = patientById(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  audit(req, 'view_case', p.phone);
  res.json({
    patient: p,
    checklist: checklist(p.phone),
    documents: all(`SELECT d.*, f.received_at, f.mime FROM documents d JOIN files f ON f.id = d.file_id WHERE d.phone = ? ORDER BY d.id`, p.phone),
    files: all(`SELECT id, mime, status, error, dup_of, received_at FROM files WHERE phone = ? ORDER BY id`, p.phone),
    messages: all(`SELECT * FROM messages WHERE phone = ? ORDER BY id`, p.phone),
    audit: all(`SELECT user, action, detail, at FROM audit WHERE phone = ? ORDER BY id DESC LIMIT 30`, p.phone),
  });
});

app.patch('/api/cases/:id', (req, res) => {
  const p = patientById(req.params.id);
  if (!p) return res.status(404).end();
  const name = String(req.body.name || '').trim().slice(0, 120) || null;
  run(`UPDATE patients SET name = ? WHERE id = ?`, name, p.id);
  audit(req, 'rename', p.phone, `${p.name || '—'} → ${name || '—'}`);
  notify(p.phone);
  res.json({ ok: true });
});

app.patch('/api/documents/:id', (req, res) => {
  const d = one(`SELECT * FROM documents WHERE id = ?`, Number(req.params.id));
  if (!d) return res.status(404).end();
  const type = req.body.type ?? d.type, status = req.body.status ?? d.status;
  if (!(type in TYPES || type === 'other') || !['ok', 'rejected', 'other'].includes(status)) return res.status(400).json({ error: 'bad type or status' });
  run(`UPDATE documents SET type = ?, status = ?, reviewed_by = ? WHERE id = ?`, type, status, req.user, d.id);
  audit(req, 'review_document', d.phone, `#${d.id} "${d.title}": ${d.status}/${d.type} → ${status}/${type}`);
  notify(d.phone);
  res.json({ ok: true });
});

app.post('/api/files/:id/reprocess', (req, res) => {
  const f = one(`SELECT phone FROM files WHERE id = ?`, Number(req.params.id));
  if (!f) return res.status(404).end();
  audit(req, 'reprocess_file', f.phone, `file #${req.params.id}`);
  reprocess(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/cases/:id/send-status', (req, res) => {
  const p = patientById(req.params.id);
  if (!p) return res.status(404).end();
  if (TWIML) return res.status(409).json({ error: 'Replies go out when the patient messages (REPLY_MODE=twiml); sending first needs a paid WhatsApp sender' });
  audit(req, 'send_status', p.phone);
  scheduleReply(p.phone, 0);
  res.json({ ok: true });
});

app.get('/api/files/:id', (req, res) => {
  const f = one(`SELECT * FROM files WHERE id = ?`, Number(req.params.id));
  if (!f) return res.status(404).end();
  audit(req, 'view_file', f.phone, `file #${f.id}`);
  const safe = f.mime === 'application/pdf' || /^image\/(jpeg|png|webp)$/.test(f.mime); // anything else downloads, never renders
  res.set({ 'Content-Type': safe ? f.mime : 'application/octet-stream', 'Content-Disposition': safe ? 'inline' : 'attachment',
    'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(path.resolve(DATA_DIR, f.path));
});

// Lets an agent (or a test script) feed a file in without WhatsApp: curl --data-binary @file.pdf -H 'content-type: application/pdf'
app.post('/api/ingest', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  const phone = String(req.query.phone || '').replace(/[^\d+]/g, '');
  if (!/^\+\d{8,15}$/.test(phone) || !req.body?.length) return res.status(400).json({ error: 'need ?phone=+<digits> and a file body' });
  audit(req, 'manual_upload', phone);
  ingestFile({ phone, buf: req.body, mime: req.get('content-type') });
  res.json({ ok: true });
});

// Server-sent events: the portal refetches whatever changed
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const off = onChange((phone) => {
    const p = one(`SELECT id FROM patients WHERE phone = ?`, phone);
    res.write(`data: ${JSON.stringify({ id: p?.id })}\n\n`);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { off(); clearInterval(ping); });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`portal on http://localhost:${port}`));
