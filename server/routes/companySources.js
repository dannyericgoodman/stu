// ══════════════════════════════════════════════════════════════════════════
// The pipes into a company card's source log.  Mounted at /api/companies.
//
// NOT routes/sources.js — that name was already taken by the sourcing CONNECTORS
// route (yc_directory, a16z_speedrun, …). Different layer, same word.
//
// Danny: "These cards should be a living, dynamic log of data I feed it from
// uploaded decks, URL links, LinkedIn links, notes, Granola notes."
//
// INGEST and EXTRACT are separate calls on purpose. Ingest is free and instant;
// extraction costs a model call. Uploading a deck must never silently spend
// money, and a failed extraction must never lose the deck.
// ══════════════════════════════════════════════════════════════════════════

const express = require('express');
const multer = require('multer');
const router = express.Router();
const db = require('../db');
const signals = require('../lib/signals');
const ingest = require('../lib/ingest');
const { extractFrom } = require('../lib/extract-signals');

// In memory, and we keep the TEXT not the binary. Storing files would need a
// volume — and DATABASE_PATH is already the one persistence question nobody has
// answered on this deploy. Danny has the original deck; Stu needs its words.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const owns = (userId, founderId) =>
  db.prepare('SELECT id FROM founders WHERE id = ? AND created_by = ? AND is_deleted = 0').get(founderId, userId);

// ── GET /api/companies/:id/sources — the log, and what each source produced ──
router.get('/:id/sources', (req, res) => {
  if (!owns(req.user.id, req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({
    sources: signals.sourcesFor(req.params.id),
    signals: signals.signalsFor(req.params.id),
  });
});

router.post('/:id/sources/url', async (req, res) => {
  if (!owns(req.user.id, req.params.id)) return res.status(404).json({ error: 'not found' });
  if (!req.body?.url) return res.status(400).json({ error: 'url required' });
  const r = await ingest.ingestUrl({ founderId: Number(req.params.id), url: req.body.url, userId: req.user.id });
  if (r.error) return res.status(400).json(r);
  if (r.created && r.id) require('../lib/extract-signals').extractSoon(Number(req.params.id), r.id, req.user.id);
  res.json(r);
});

router.post('/:id/sources/deck', upload.single('file'), async (req, res) => {
  if (!owns(req.user.id, req.params.id)) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const r = await ingest.ingestDeck({
    founderId: Number(req.params.id), buffer: req.file.buffer,
    fileName: req.file.originalname, userId: req.user.id,
  });
  if (r.error) return res.status(400).json(r);
  // Analyse it without being asked. The upload stays the thing that can't fail; the
  // extraction happens after the response, so a bad model call still leaves the deck.
  if (r.created && r.id) require('../lib/extract-signals').extractSoon(Number(req.params.id), r.id, req.user.id);
  res.json(r);
});

// ── POST /api/companies/:id/sources/dataroom — multi-file bulk upload ──
// A data room arrives as a folder of files, not one deck. This is the one new input
// the rescope adds: drop the whole room in at once. Each file is ingested through the
// SAME honesty gate as a single upload — a PDF that's really scanned images, or a file
// too short to be a source, is dropped with a reason rather than fabricated over. The
// upload is the thing that can't fail; per-file extraction happens after the response.
//
// PDFs go through ingestDeck (pdf-parse); text/markdown files go through ingestNote
// with the filename as the title. Anything else is reported as unsupported, not
// silently swallowed — a gate you can't see is indistinguishable from one that found
// nothing.
router.post('/:id/sources/dataroom', upload.array('files', 40), async (req, res) => {
  if (!owns(req.user.id, req.params.id)) return res.status(404).json({ error: 'not found' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'no files' });

  const founderId = Number(req.params.id);
  const results = [];
  for (const f of files) {
    const name = f.originalname || 'file';
    const isPdf = /\.pdf$/i.test(name) || f.mimetype === 'application/pdf';
    const isText = /\.(txt|md|markdown|csv)$/i.test(name) || /^text\//.test(f.mimetype || '');

    let r;
    if (isPdf) {
      r = await ingest.ingestDeck({ founderId, buffer: f.buffer, fileName: name, userId: req.user.id });
    } else if (isText) {
      // A data-room memo/one-pager: keep its words as a note, titled by the filename.
      r = ingest.ingestNote({ founderId, text: f.buffer.toString('utf8'), title: name, userId: req.user.id });
    } else {
      // PPTX, images, xlsx, etc. can't be text-extracted here — say so honestly rather
      // than storing an unreadable blob the agents would have to guess at.
      results.push({ file: name, ok: false, error: `unsupported type — extract text and re-upload as .pdf or .txt` });
      continue;
    }

    if (r.error) {
      results.push({ file: name, ok: false, error: r.error, detail: r.detail });
      continue;
    }
    // Analyse each new source without being asked, after the response is safe.
    if (r.created && r.id) require('../lib/extract-signals').extractSoon(founderId, r.id, req.user.id);
    results.push({ file: name, ok: true, kind: isPdf ? 'deck' : 'note', chars: r.chars, created: !!r.created, deduped: !r.created });
  }

  const kept = results.filter((x) => x.ok).length;
  res.json({ total: files.length, kept, dropped: files.length - kept, results });
});

router.post('/:id/sources/note', (req, res) => {
  if (!owns(req.user.id, req.params.id)) return res.status(404).json({ error: 'not found' });
  const r = ingest.ingestNote({
    founderId: Number(req.params.id), text: req.body?.text,
    title: req.body?.title, occurredAt: req.body?.occurred_at, userId: req.user.id,
  });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// ── Propose, then gate. ──
// The response reports proposed AND kept AND why each was dropped. A gate you
// can't see is indistinguishable from an extractor that found nothing.
router.post('/:id/sources/:sourceId/extract', async (req, res) => {
  if (!owns(req.user.id, req.params.id)) return res.status(404).json({ error: 'not found' });
  const source = db.prepare('SELECT * FROM company_sources WHERE id = ? AND founder_id = ?')
    .get(req.params.sourceId, req.params.id);
  if (!source) return res.status(404).json({ error: 'no such source' });

  const { candidates, error, model } = await extractFrom(source, { userId: req.user.id });
  if (error) return res.status(502).json({ error });

  // Re-reading the same deck must not double the card.
  db.prepare('DELETE FROM company_signals WHERE source_id = ?').run(source.id);

  const r = signals.recordSignals({
    founderId: Number(req.params.id), sourceId: source.id, candidates, model, createdBy: req.user.id,
  });
  res.json({ proposed: candidates.length, ...r });
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/companies/:id/read — run a conviction read from the card's sources.
//
// Danny's ask, verbatim: "For companies that enter the pipeline and have a first
// call, I will have call notes, likely a deck, and some URLs to use to evaluate
// the opportunity."
//
// He shouldn't have to re-upload any of it. The card already holds every source;
// this hands them to the engine in the shape it wants and returns the assessment
// id so the UI can walk him to his own call.
//
// The mapping is load-bearing, not cosmetic. computeEvidenceRung() reads
// input_type, and only 'transcript' (or notes that look like a meeting record)
// reaches OBSERVED — the rung below which the engine REFUSES to score. So a
// Granola call must arrive as a transcript or the read silently holds for lack of
// evidence that is sitting right there.
// ══════════════════════════════════════════════════════════════════════════
router.post('/:id/read', async (req, res) => {
  if (!owns(req.user.id, req.params.id)) return res.status(404).json({ error: 'not found' });

  const sources = db.prepare(
    'SELECT kind, title, content_text, occurred_at FROM company_sources WHERE founder_id = ? AND content_text IS NOT NULL'
  ).all(req.params.id);

  if (!sources.length) {
    return res.status(400).json({
      error: 'Nothing to read yet.',
      detail: 'Add a deck, a URL, or a call note to this card first — the engine refuses to score what it cannot see.',
    });
  }

  const inputs = {
    decks: sources.filter((s) => s.kind === 'deck').map((s) => ({ label: s.title, content: s.content_text })),
    // granola AND note both land here. A Granola call IS a record of a
    // conversation, which is exactly what the OBSERVED rung means.
    transcripts: sources
      .filter((s) => s.kind === 'granola')
      .map((s) => ({ label: `${s.title}${s.occurred_at ? ` (${s.occurred_at})` : ''}`, content: s.content_text })),
    notes: sources.filter((s) => s.kind === 'note').map((s) => ({ label: s.title, content: s.content_text })),
    urls: [],
  };
  // A URL's TEXT is already extracted and stored; re-fetching it would pay Exa
  // twice for the same page. It rides in as a note with its origin in the label.
  for (const s of sources.filter((s) => s.kind === 'url')) {
    inputs.notes.push({ label: `Web — ${s.title}`, content: s.content_text });
  }

  try {
    // Reuse the real intake rather than re-implementing it. One path in means the
    // engine, the retries, the conviction write and the version history can't
    // drift from what the Assess page does.
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || process.env.STU_PORT || 3002}/api/assessments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization },
      body: JSON.stringify({ founder_id: Number(req.params.id), assessment_type: 'assessment', inputs }),
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json(d);
    res.json({ ...d, used: { decks: inputs.decks.length, transcripts: inputs.transcripts.length, notes: inputs.notes.length } });
  } catch (e) {
    console.error('[Card] read failed:', e.message);
    res.status(500).json({ error: 'Could not start the read: ' + e.message });
  }
});

// The signals go with it. A claim must never outlive its evidence.
router.delete('/:id/sources/:sourceId', (req, res) => {
  if (!owns(req.user.id, req.params.id)) return res.status(404).json({ error: 'not found' });
  signals.deleteSource(Number(req.params.id), Number(req.params.sourceId));
  res.json({ deleted: true });
});

module.exports = router;
