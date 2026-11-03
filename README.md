# Claim Docs: WhatsApp Document Tracker

Patients send their claim documents on WhatsApp. This system reads each file as it arrives, works out what each document is, and keeps a live checklist per patient in an agent portal. It also replies on WhatsApp with what is still pending.

**Live portal:** https://carefi-whatsapp-tracker.onrender.com (agent login shared separately)

## Try it

1. On WhatsApp, send **`join turn-pond`** to **+1 415 523 8886**. This is the Twilio sandbox, and joining is a one-time step per phone.
2. Send photos or PDFs of claim documents.
3. Watch the portal update within seconds. You get a WhatsApp reply listing what was received, what to resend and what is still pending.
4. Send `status` at any time to get the current checklist.

## Required documents

KYC (Aadhaar or PAN) · Policy copy or health card · Discharge summary · Final hospital bill · Investigation reports · Consultation papers · Pharmacy bills · Cancelled cheque

## How messy inputs are handled

| Situation | What happens |
|---|---|
| **Several documents in one PDF** | The model splits the file by page range, e.g. discharge summary p.1, consultation p.2, pharmacy bill p.3, and each document ticks its own checklist item. |
| **One document sent as many photos** | Photos are processed one at a time per patient, and each is compared with what is already in the case. Page 2 of a bill with the same bill number is linked to page 1 and shown as part of it. |
| **Same document sent twice** | An identical file is caught by its SHA-256 fingerprint without calling the AI. A re-photographed page (different file, same content) is marked as a duplicate of the original. The patient is told "no need to send it again". |
| **Blurry or cut-off images** | Marked *unreadable* with a reason ("photo is blurry", "bottom half cut off"). It does **not** tick the checklist, and the patient is asked to resend. |
| **Document belongs to someone else** | The name on the document is compared with the patient's name, which is learned from their medical papers, and with the policyholder from the policy copy, since KYC and the cheque may legitimately be in the policyholder's name. A mismatch is flagged for an agent and not counted. |
| **Not a required document** | A driving licence, payment receipt, selfie and so on are labelled "not a required document". KYC is strictly Aadhaar or PAN. |
| **Unsupported file** | Audio, video or Word files are recorded, and the patient is asked to send a photo or PDF instead. |

The AI never has the final say: agents can **accept** a flagged document (and change its type), **reject** it, or **retry** a failed file. Every review is recorded.

## Portal

- **Case list:** every patient with an 8-square progress strip, an `x/8` count, what is missing, and a badge when something needs review. It updates live over server-sent events, with no refresh.
- **Case page:** the checklist with ✓/✕ and the files received under each item, a *Needs attention* panel (blurry, possibly another person, failed), duplicates and other files, the WhatsApp conversation, and an access log.

## Patient data

- Named agent logins (`AGENTS=user:pass,...`), signed HttpOnly session cookies that expire after 12 hours, and rate-limited login.
- Documents are served only to logged-in agents, with `Cache-Control: no-store`. Anything that isn't an image or PDF is downloaded, never displayed in the browser, and is sandboxed so it can't run scripts in the portal.
- Phone numbers are partly hidden in the case list.
- Only the **last 4 characters** of Aadhaar, PAN and bank account numbers are stored as identifiers.
- Every Twilio webhook's signature is checked (HMAC-SHA1), so forged requests are rejected.
- An access log records every case view, file view, review, rename and upload, and shows it on the case page.
- Note: the demo uses the free Gemini API tier, where Google may use what we send to improve its products. Real patient data needs the paid tier (or Vertex AI), where it doesn't.

## How it works

```
WhatsApp ─▶ Twilio sandbox ─▶ POST /webhook/whatsapp  (signature checked)
                                   │  download media, SHA-256 dedupe
                                   ▼
                     per-patient serial queue ─▶ Gemini 2.5 Flash (image/PDF + case context)
                                   │             → documents[]: type, pages, name, id, legible,
                                   │               belongs_to_case, new/continuation/duplicate
                                   ▼
                     status rules ─▶ SQLite ─▶ live updates ─▶ portal
                                   ▼
                     TwiML reply with the checklist status
```

- **One AI call per file.** Gemini gets the file plus the case so far: patient, policyholder, and documents already received. It returns structured JSON (a response schema), so it can judge "continuation" and "duplicate" against real context.
- **Status rules in code, not in the prompt:** unreadable → someone else's → duplicate → not required → counted. Covered by `pipeline.test.js`.
- **Replies are sent as TwiML in the webhook response.** Twilio trial and sandbox senders reject free-form sends through the REST API (error 21654). The webhook waits up to 11 seconds for that message's files, then answers. When several photos arrive together, only the newest webhook replies, so the patient gets one message. Set `REPLY_MODE=rest` with a paid sender to send asynchronously instead.
- **Rate limits:** on a 429, the call moves to `gemini-2.5-flash-lite` (a separate free allowance), then waits as long as Google's `retryDelay` says.

Stack: Node 24 (built-in `node:sqlite`), Express 5 (the only dependency), plain HTML/JS portal, Gemini API, Twilio WhatsApp.

## Run locally

```bash
cp .env.example .env      # fill GEMINI_API_KEY, TWILIO_*, AGENTS, SESSION_SECRET
npm install
npm start                 # http://localhost:3000
npm test
```

Expose port 3000 with any tunnel (e.g. `ngrok http 3000`) and set the Twilio sandbox's *When a message comes in* to `https://<tunnel>/webhook/whatsapp` (POST).

To feed a file in without WhatsApp, while logged in:
`curl -b cookies.txt -H 'content-type: application/pdf' --data-binary @file.pdf 'http://localhost:3000/api/ingest?phone=%2B919800000000'`

## Deploy

- **Render:** `render.yaml` is a Blueprint (free plan; secrets are asked for in the dashboard). The app keeps itself awake on the free tier, because Twilio won't wait for a cold start.
- **Any Ubuntu server (EC2, Oracle, DigitalOcean):** paste `deploy/ec2-setup.sh` as the server's launch script. It installs Node and Caddy (automatic HTTPS on `<ip>.sslip.io`) and runs the app as a service. Then fill in the keys in `/opt/claimdocs/.env`.

## Known limits

- **Twilio sandbox:** each tester joins once with the code. Replies only go out in response to a patient's message, so "send status" from the portal needs a paid WhatsApp sender. If a burst of photos takes longer than ~11 seconds to read, the reply says "still reading", and the next message gets the full status.
- **Render free tier:** there is no persistent disk, so a restart or redeploy clears the database and files. Use a paid disk or a server for real use.
- **Gemini free tier:** about 10 requests a minute plus a daily cap. Use a paid key for production, which also stops Google using the data.
