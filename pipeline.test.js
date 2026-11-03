import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claimdocs-'));
const { decide, statusMessage, ensurePatient, checklist } = await import('./pipeline.js');
const { run } = await import('./db.js');

const doc = (o) => ({ type: 'final_bill', legible: true, belongs_to_case: 'yes', relation: 'new', related_doc_id: 0, reason: 'r', ...o });

test('decide: status priority', () => {
  const ids = new Set([7]);
  assert.equal(decide(doc({ legible: false, belongs_to_case: 'no' }), ids).status, 'unreadable');
  assert.equal(decide(doc({ belongs_to_case: 'no' }), ids).status, 'wrong_patient');
  assert.equal(decide(doc({ relation: 'duplicate', related_doc_id: 7 }), ids).status, 'duplicate');
  assert.equal(decide(doc({ relation: 'duplicate', related_doc_id: 99 }), ids).status, 'ok'); // unknown id: don't drop it
  assert.deepEqual(decide(doc({ relation: 'continuation', related_doc_id: 7 }), ids).related, 7);
  assert.equal(decide(doc({ type: 'other' }), ids).status, 'other');
  assert.equal(decide(doc({ belongs_to_case: 'unknown' }), ids).status, 'ok');
});

test('checklist + WhatsApp status message', () => {
  const ph = '+919800000001';
  ensurePatient(ph, 'Rahul');
  run(`UPDATE patients SET name = 'Rahul Sharma' WHERE phone = ?`, ph);
  const f = run(`INSERT INTO files(phone, sha256, mime, path, status) VALUES(?, 'x', 'image/jpeg', 'files/x.jpg', 'done')`, ph).lastInsertRowid;
  const ins = (type, title, status, extra = {}) => run(`INSERT INTO documents(file_id, phone, type, title, status, note, patient_name) VALUES(?,?,?,?,?,?,?)`,
    f, ph, type, title, status, extra.note ?? null, extra.name ?? null);
  ins('discharge_summary', 'Discharge summary', 'ok');
  ins('final_bill', 'Final bill', 'unreadable', { note: 'photo is blurry' });
  ins('kyc', 'Aadhaar card', 'wrong_patient', { name: 'Priya Verma' });

  assert.deepEqual(checklist(ph).filter((c) => c.received).map((c) => c.key), ['discharge_summary']);
  const m = statusMessage(ph);
  assert.match(m, /^Hi Rahul,/);
  assert.match(m, /Received \(1\/8\):\n• Discharge summary/);
  assert.match(m, /resend a clearer photo of "Final bill" — photo is blurry/);
  assert.match(m, /"Aadhaar card" seems to be for Priya Verma, not Rahul Sharma/);
  assert.match(m, /Still needed \(7\):/);
  assert.match(m, /• KYC \(Aadhaar or PAN\)/);
});
