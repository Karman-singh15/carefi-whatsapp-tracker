import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, one, all, run } from './db.js';

export const TYPES = {
  kyc: 'KYC (Aadhaar or PAN)',
  policy: 'Policy copy or health card',
  discharge_summary: 'Discharge summary',
  final_bill: 'Final hospital bill',
  investigation_report: 'Investigation reports',
  consultation: 'Consultation papers',
  pharmacy_bill: 'Pharmacy bills',
  cancelled_cheque: 'Cancelled cheque',
};
const MEDICAL = ['discharge_summary', 'final_bill', 'investigation_report', 'consultation', 'pharmacy_bill'];
const MIME_EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };

// ---- change notifications (SSE in server.js listens) ----
const listeners = new Set();
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const changed = (phone) => listeners.forEach((fn) => fn(phone));

export function ensurePatient(phone, profileName) {
  run(`INSERT INTO patients(phone, profile_name) VALUES(?, ?)
       ON CONFLICT(phone) DO UPDATE SET profile_name = coalesce(excluded.profile_name, profile_name)`, phone, profileName || null);
}
const touch = (phone) => run(`UPDATE patients SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE phone = ?`, phone);

export function checklist(phone) {
  const got = new Set(all(`SELECT DISTINCT type FROM documents WHERE phone = ? AND status = 'ok'`, phone).map((r) => r.type));
  return Object.entries(TYPES).map(([key, label]) => ({ key, label, received: got.has(key) }));
}

// ---- per-phone serial queue: photos of one document must be judged in order ----
const queues = new Map();
function enqueue(phone, job) {
  const p = (queues.get(phone) || Promise.resolve()).then(job).catch((e) => console.error('job failed', e));
  queues.set(phone, p);
  p.then(() => queues.get(phone) === p && queues.delete(phone));
  return p;
}

export function ingestFile({ phone, buf, mime, profileName }) {
  ensurePatient(phone, profileName);
  touch(phone);
  mime = (mime || '').split(';')[0].trim().toLowerCase();
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const ext = MIME_EXT[mime];
  const rel = `files/${sha}.${ext || 'bin'}`;
  fs.writeFileSync(path.join(DATA_DIR, rel), buf);
  const prev = one(`SELECT id FROM files WHERE phone = ? AND sha256 = ? AND status IN ('processing', 'done') ORDER BY id LIMIT 1`, phone, sha);
  const status = !ext ? 'unsupported' : prev ? 'duplicate' : 'processing';
  const id = Number(run(`INSERT INTO files(phone, sha256, mime, path, status, dup_of) VALUES(?,?,?,?,?,?)`,
    phone, sha, mime, rel, status, prev?.id ?? null).lastInsertRowid);
  changed(phone);
  return enqueue(phone, async () => {
    if (status === 'processing') await processFile(id);
    if (process.env.REPLY_MODE === 'rest') scheduleReply(phone); // twiml mode: the webhook replies
  });
}

export const reprocess = (id) => {
  const f = one(`SELECT phone FROM files WHERE id = ?`, id);
  return f && enqueue(f.phone, () => processFile(id));
};

async function processFile(id) {
  const f = one(`SELECT * FROM files WHERE id = ?`, id);
  run(`DELETE FROM documents WHERE file_id = ?`, id);
  run(`UPDATE files SET status = 'processing', error = NULL WHERE id = ?`, id);
  changed(f.phone);
  const patient = one(`SELECT * FROM patients WHERE phone = ?`, f.phone);
  const existing = all(`SELECT id, type, title, pages, patient_name, identifier FROM documents
                        WHERE phone = ? AND status IN ('ok', 'other') ORDER BY id`, f.phone);
  try {
    const docs = await classify(fs.readFileSync(path.join(DATA_DIR, f.path)), f.mime, patient, existing);
    const ids = new Set(existing.map((e) => e.id));
    for (const d of docs) {
      const { status, note, related } = decide(d, ids);
      run(`INSERT INTO documents(file_id, phone, type, title, pages, patient_name, identifier, status, note, related_id)
           VALUES(?,?,?,?,?,?,?,?,?,?)`, id, f.phone, d.type, d.title, d.pages, d.patient_name || null,
        d.identifier || null, status, note, related);
      if (status === 'ok' && d.patient_name && MEDICAL.includes(d.type))
        run(`UPDATE patients SET name = ? WHERE phone = ? AND name IS NULL`, d.patient_name, f.phone);
      if (status === 'ok' && d.type === 'policy' && d.policyholder_name)
        run(`UPDATE patients SET policyholder = ? WHERE phone = ? AND policyholder IS NULL`, d.policyholder_name, f.phone);
    }
    run(`UPDATE files SET status = 'done' WHERE id = ?`, id);
  } catch (e) {
    console.error('classify failed', id, e.message);
    run(`UPDATE files SET status = 'error', error = ? WHERE id = ?`, String(e.message).slice(0, 500), id);
  }
  touch(f.phone);
  changed(f.phone);
}

// Turns the model's judgement into a checklist status. Order matters: an unreadable page can't be judged further.
export function decide(d, existingIds) {
  const related = existingIds.has(d.related_doc_id) ? d.related_doc_id : null;
  if (!d.legible) return { status: 'unreadable', note: d.quality_note || 'Too blurry or unclear to read', related: null };
  if (d.belongs_to_case === 'no') return { status: 'wrong_patient', note: d.reason, related: null };
  if (d.relation === 'duplicate' && related) return { status: 'duplicate', note: d.reason, related };
  if (!TYPES[d.type]) return { status: 'other', note: d.reason, related };
  return { status: 'ok', note: d.reason, related };
}

// ---- Gemini ----
const S = (extra = {}) => ({ type: 'STRING', ...extra });
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    documents: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: S({ enum: [...Object.keys(TYPES), 'other'] }),
          pages: S(),
          title: S(),
          patient_name: S(),
          policyholder_name: S(),
          identifier: S(),
          legible: { type: 'BOOLEAN' },
          quality_note: S(),
          belongs_to_case: S({ enum: ['yes', 'no', 'unknown'] }),
          relation: S({ enum: ['new', 'continuation', 'duplicate'] }),
          related_doc_id: { type: 'INTEGER' },
          reason: S(),
        },
        required: ['type', 'pages', 'title', 'patient_name', 'legible', 'belongs_to_case', 'relation', 'related_doc_id', 'reason'],
        propertyOrdering: ['type', 'pages', 'title', 'patient_name', 'policyholder_name', 'identifier', 'legible', 'quality_note', 'belongs_to_case', 'relation', 'related_doc_id', 'reason'],
      },
    },
  },
  required: ['documents'],
};

function prompt(patient, existing) {
  return `You review documents that a patient sent on WhatsApp for an Indian health-insurance claim.
The attached file is one photo/scan, or a PDF that may contain several different documents.

Split the file into separate documents. Consecutive pages of the same document belong together; a new document starts when the kind of document, issuer, or date changes. For each document return:

type — exactly one of:
  kyc: ONLY an Aadhaar card or a PAN card (front or back, e-Aadhaar printout included). A driving licence, voter ID, passport or any other ID is NOT kyc — it is "other".
  policy: health-insurance policy copy / policy schedule / certificate of insurance, or an insurer / TPA health card (e-card)
  discharge_summary: hospital discharge summary or discharge card (diagnosis, admission and discharge dates, treatment given)
  final_bill: final in-patient hospital bill, bill summary, or itemised bill breakup from the hospital. An estimate, advance receipt or interim bill is "other".
  investigation_report: lab reports (blood, urine, pathology, histopathology, culture), imaging reports (X-ray, CT, MRI, ultrasound), ECG / echo / endoscopy reports
  consultation: doctor consultation papers — OPD notes, prescriptions, case sheets, referral letters, doctor's advice on letterhead
  pharmacy_bill: bill / invoice / cash memo for medicines from a pharmacy or chemist (including the hospital pharmacy)
  cancelled_cheque: a cheque leaf, usually with "CANCELLED" written across it
  other: anything else (payment receipt, other ID cards, selfie, random photo, blank page, a chat screenshot)
pages — page numbers inside this file, e.g. "1" or "2-4". A photo is "1".
title — a short label for an agent, e.g. "CBC report, 12 Mar 2025" or "Aadhaar card (front)".
patient_name — the person the document is about: the patient on medical papers, the holder on ID / cheque. Empty string if no name is visible.
policyholder_name — for policy documents only: the proposer / policyholder. Otherwise empty.
identifier — the most specific reference on the document: bill / invoice number, UHID / IP number, policy number, report or sample id. For Aadhaar, PAN and bank accounts give ONLY the last 4 characters (privacy). Empty if none.
legible — false if the image is too blurry, dark, cropped or glared to read the key details (name, dates, amounts, results). Slightly imperfect but readable is true.
quality_note — if not legible, what is wrong in plain words ("photo is blurry", "bottom half is cut off"). Otherwise empty.
belongs_to_case — "yes" when the name matches the patient on file (allow initials, spelling variants, different name order) or matches the policyholder on file. A policy that lists the patient among several insured members is "yes". "no" when a name is visible and it is clearly a different person from both the patient and the policyholder on file — this includes KYC or a cheque in someone else's name while no policyholder is on file yet (an agent will confirm). "unknown" only when no name is visible, or there is no patient name on file yet.
relation — compare with the documents already received in this case:
  new: not received before
  continuation: another page or part of a document already received (same bill number / same report / same discharge summary, different page)
  duplicate: the same page or content we already have, sent again (e.g. a re-taken photo or a re-sent PDF of the same page)
related_doc_id — for continuation or duplicate, the id of that already-received document; otherwise 0.
reason — one short sentence explaining the type you chose.

Case context:
- Patient name on file: ${patient?.name || 'unknown yet'}
- Policyholder on file: ${patient?.policyholder || 'unknown yet'}
- Documents already received: ${existing.length ? JSON.stringify(existing) : 'none'}

Always return at least one document, even for a blank or unrelated image (type "other").`;
}

async function classify(buf, mime, patient, existing) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  if (buf.length > 18 * 1024 * 1024) throw new Error('File is larger than 18 MB');
  // Each model has its own free-tier quota; on a rate limit try the next one before waiting.
  const models = [...new Set([process.env.GEMINI_MODEL || 'gemini-2.5-flash', process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite'])];
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: buf.toString('base64') } }, { text: prompt(patient, existing) }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  });
  for (let round = 1; ; round++) {
    let wait = 3000 * round, last;
    for (const model of models) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body,
      });
      if (r.ok) {
        const j = await r.json();
        const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        const docs = JSON.parse(text || '{}').documents;
        if (!Array.isArray(docs) || !docs.length) throw new Error('Model returned no documents');
        return docs;
      }
      const t = await r.text();
      last = `Gemini ${model} ${r.status}: ${t.slice(0, 300)}`;
      if (![429, 500, 502, 503, 504].includes(r.status)) throw new Error(last);
      const hint = t.match(/"retryDelay":\s*"(\d+)/); // Google says how long the per-minute window needs
      if (hint) wait = Math.max(wait, Math.min(Number(hint[1]) * 1000, 60000));
    }
    if (round >= 4) throw new Error(last);
    console.warn(`rate limited, retrying in ${wait / 1000}s`);
    await new Promise((res) => setTimeout(res, wait));
  }
}

// ---- WhatsApp replies ----
const timers = new Map();
// Patients send photos in bursts; wait for a quiet moment and send one summary instead of one per photo.
export function scheduleReply(phone, delay = Number(process.env.REPLY_DELAY_MS ?? 8000)) {
  clearTimeout(timers.get(phone));
  timers.set(phone, setTimeout(() => {
    timers.delete(phone);
    if (queues.has(phone)) return scheduleReply(phone, 3000);
    sendWhatsApp(phone, statusMessage(phone)).catch((e) => console.error('reply failed', e));
  }, delay));
}

export function statusMessage(phone) {
  const p = one(`SELECT * FROM patients WHERE phone = ?`, phone);
  const since = one(`SELECT max(created_at) t FROM messages WHERE phone = ? AND direction = 'out'`, phone).t || '';
  const docs = all(`SELECT * FROM documents WHERE phone = ? AND created_at > ? ORDER BY id`, phone, since);
  const files = all(`SELECT * FROM files WHERE phone = ? AND received_at > ? AND status IN ('error','unsupported','duplicate')`, phone, since);
  const cl = checklist(phone);
  const got = cl.filter((c) => c.received), missing = cl.filter((c) => !c.received);
  const first = (p?.name || '').split(' ')[0];

  const L = [`Hi${first ? ' ' + first : ''}, here is your claim document status 📋`];
  if (got.length) L.push('', `✅ Received (${got.length}/8):`, ...got.map((c) => `• ${c.label}`));
  const notes = [];
  for (const d of docs) {
    if (d.status === 'unreadable') notes.push(`📷 Please resend a clearer photo of "${d.title}" — ${d.note}.`);
    if (d.status === 'wrong_patient') notes.push(`❓ "${d.title}" seems to be for ${d.patient_name || 'someone else'}${p?.name ? `, not ${p.name}` : ''}. Please check and send the right one.`);
    if (d.status === 'duplicate') notes.push(`ℹ️ We already have "${d.title}", no need to send it again.`);
    if (d.status === 'other') notes.push(`ℹ️ "${d.title}" is not one of the documents we need.`);
  }
  for (const f of files) {
    if (f.status === 'duplicate') notes.push('ℹ️ You sent the same file twice, we already have it.');
    if (f.status === 'unsupported') notes.push('⚠️ We can only read photos and PDFs. Please send that file as a photo or PDF.');
    if (f.status === 'error') notes.push("⚠️ We couldn't process one of your files. Please send it again.");
  }
  if (notes.length) L.push('', ...new Set(notes));
  if (missing.length) L.push('', `⏳ Still needed (${missing.length}):`, ...missing.map((c) => `• ${c.label}`), '', 'Just send photos or PDFs here in this chat.');
  else L.push('', '🎉 We have all 8 documents. Our team will take it from here.');
  return L.join('\n');
}

export async function sendWhatsApp(phone, body) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok } = process.env;
  const from = one(`SELECT wa_number FROM patients WHERE phone = ?`, phone)?.wa_number || process.env.TWILIO_WHATSAPP_FROM;
  let status = 'sent';
  if (!sid || !tok || !from) status = 'not sent: Twilio not configured';
  else {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
      body: new URLSearchParams({ From: `whatsapp:${from.replace(/^whatsapp:/, '')}`, To: `whatsapp:${phone}`, Body: body.slice(0, 1600) }),
    });
    if (!r.ok) { status = `failed: ${r.status}`; console.error('twilio send', r.status, await r.text()); }
  }
  recordOutgoing(phone, body, status);
}

export function recordOutgoing(phone, body, status) {
  run(`INSERT INTO messages(phone, direction, body, status) VALUES(?, 'out', ?, ?)`, phone, body, status);
  changed(phone);
}

export function logIncoming(phone, body) {
  run(`INSERT INTO messages(phone, direction, body, status) VALUES(?, 'in', ?, 'received')`, phone, body);
  touch(phone);
  changed(phone);
}

export function notify(phone) { changed(phone); }
