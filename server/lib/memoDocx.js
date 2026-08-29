'use strict';
// ══════════════════════════════════════════════════════════════════════════
// memoDocx — turn a finished Assess run into an editable Word memo.
//
// Danny: "As long as the Assess feature is genuinely strong I can get up the field
// on memo writing. Perhaps there could be a download function from Assess that
// produces as close to memo as possible (fully cited, accurate, written in my
// voice, produced as a docx file so I can edit it)."
//
// THREE RULES, and they are the whole design:
//
// 1. ASSEMBLE, NEVER REGENERATE. Every sentence in this document was already
//    written by the run — the panel's `read`, the Bear's risks, the synthesis. The
//    assessment is already written in Danny's voice (that was a separate build). If
//    this module sent the text back through a model to "make it memo-like" it would
//    launder verified prose into fresh, unverified prose and quietly break the one
//    property that makes the assessment worth exporting. So there is no model call
//    in this file. It is a formatter.
//
// 2. THE SEAMS STAY VISIBLE. What Stu does not know, the memo says it does not
//    know. The Decision Header carries [DANNY: …] placeholders for recommendation,
//    entry terms and return shape, because those are his calls and no agent has the
//    facts. A blank he must fill beats a number a reader might trust.
//
// 3. CITATIONS TRAVEL WITH THE CLAIM. The sources the run actually read are listed,
//    and the quote-integrity verdict from agents/verify.js is printed next to the
//    room's output. A memo that cites nothing is exactly the artifact this product
//    exists to replace.
// ══════════════════════════════════════════════════════════════════════════

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} = require('docx');

const FONT = 'Calibri';
const GREY = '595959';

// ── Text plumbing ──────────────────────────────────────────────────────
// Agent fields are not uniformly strings: string | string[] | object[] | object.
// Same forgiveness buildMemo7M applies, kept local so this file has no coupling
// into the route.
function flat(v, depth = 0) {
  if (v == null || depth > 4) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => flat(x, depth + 1)).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    for (const k of ['text', 'prose', 'read', 'assessment', 'summary', 'body', 'description', 'risk', 'q']) {
      if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim();
    }
    // Fall-through: dump the remaining values, but NOT the scoring metadata that
    // rides alongside the prose. bear.twelve_month_kill is
    // {scenario, confidence, adjustment} — flattening every value printed a
    // paragraph, then the bare word "high", then "-0.3", into the middle of "Why it
    // could fail". A number with no label is not a sentence, and a memo that emits
    // one has told the reader something false about how carefully it was built.
    const META = new Set(['confidence', 'adjustment', 'score', 'weight', 'severity', 'delta', 'rank', 'order', 'key', 'label', 'verification']);
    return Object.entries(v)
      .filter(([k, x]) => {
        if (META.has(String(k).toLowerCase())) return false;
        if (typeof x === 'number' || typeof x === 'boolean') return false;
        // A very short string in an object is a tag ("high", "medium"), not prose.
        if (typeof x === 'string' && x.trim().length < 25) return false;
        return true;
      })
      .map(([, x]) => flat(x, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
const j = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };

// ── Building blocks ────────────────────────────────────────────────────
const P = (text, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 120, line: 276 },
  alignment: opts.align,
  children: [new TextRun({
    text: String(text ?? ''),
    font: FONT, size: opts.size ?? 21,
    bold: opts.bold, italics: opts.italics, color: opts.color,
  })],
});

const H = (text, level) => new Paragraph({
  heading: level,
  spacing: { before: 260, after: 120 },
  children: [new TextRun({ text, font: FONT, bold: true, size: level === HeadingLevel.HEADING_1 ? 30 : 24 })],
});

// Body prose: split on blank lines and bullet-ish leaders so a wall of text arrives
// as paragraphs and lists rather than one block he has to re-break by hand.
function prose(text) {
  const out = [];
  for (const chunk of String(text || '').split(/\n{2,}/)) {
    for (const line of chunk.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const bullet = /^[-•*·]\s+/.test(t);
      out.push(new Paragraph({
        spacing: { after: 100, line: 276 },
        bullet: bullet ? { level: 0 } : undefined,
        children: [new TextRun({ text: bullet ? t.replace(/^[-•*·]\s+/, '') : t, font: FONT, size: 21 })],
      }));
    }
  }
  return out;
}

const cell = (text, { bold = false, width = 50 } = {}) => new TableCell({
  width: { size: width, type: WidthType.PERCENTAGE },
  margins: { top: 60, bottom: 60, left: 110, right: 110 },
  children: [P(text, { bold, after: 0 })],
});

const factTable = (rows) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: {
    top: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
    left: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
    right: { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
    insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
  },
  rows: rows.map(([k, v]) => new TableRow({
    children: [cell(k, { bold: true, width: 24 }), cell(v, { width: 76 })],
  })),
});

const money = (n) => (n == null || n === '' ? null
  : (Number(n) >= 1e6 ? `$${(Number(n) / 1e6).toFixed(Number(n) % 1e6 ? 2 : 0)}M`
    : `$${Number(n).toLocaleString()}`));

// ══════════════════════════════════════════════════════════════════════════
// buildMemoDoc(assessment, { memo7m, defensibility, sources })
// Returns a docx Document. Pure — no DB, no network, no model.
// ══════════════════════════════════════════════════════════════════════════
function buildMemoDoc(a, { memo7m = [], defensibility = null, sources = [] } = {}) {
  const syn = j(a.synthesis_output) || {};
  const conv = j(a.conviction_output) || {};
  const panel = j(a.panel_output) || [];
  const agenda = j(a.agenda_output) || {};
  const bear = j(a.bear_agent_output) || {};

  const company = a.founder_company || 'Untitled company';
  const today = new Date().toISOString().slice(0, 10);
  const kids = [];

  // ── Title ────────────────────────────────────────────────────────────
  kids.push(new Paragraph({
    heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER,
    spacing: { after: 60 },
    children: [new TextRun({ text: `${company} — Investment Memo`, font: FONT, bold: true, size: 32 })],
  }));
  kids.push(P(`Confidential · Draft for discussion · ${today}`, {
    align: AlignmentType.CENTER, italics: true, color: GREY, size: 19, after: 240,
  }));

  // ── Decision Header ──────────────────────────────────────────────────
  // House standard: page one is a decision nothing below it can change. Stu cannot
  // supply the recommendation, the entry terms or the return shape — those are
  // Danny's. They ship as explicit blanks rather than as a machine's guess.
  kids.push(H('Decision Header', HeadingLevel.HEADING_2));
  const band = conv.band || {};
  kids.push(factTable([
    ['Recommendation', '[DANNY: Invest / Pass / Watch · $ amount · resulting ownership]'],
    ['The bet, in one falsifiable sentence',
      '[DANNY: We believe X. Right if [measurable Y] by [date Z]; wrong if not.]'],
    ['Entry', '[DANNY: round · valuation · our check → ownership]'],
    ['Stu conviction',
      conv.determinate === false || conv.score == null
        ? 'Indeterminate — not enough evidence to score. See Calibration below.'
        : `${conv.score}/10 · ${band.label || '—'}${band.action ? ` · ${band.action}` : ''} · evidence rung ${conv.rung ?? '—'}${conv.rung_label ? ` (${conv.rung_label})` : ''}`],
    ['Return shape', '[DANNY: bear / base / bull, one line each]'],
  ]));

  // Why it could fail leads, up front, per the house standard.
  const failBullets = [bear.primary_risks, bear.twelve_month_kill, bear.kill_shot_risk]
    .map(flat).filter(Boolean).join('\n');
  if (failBullets) {
    kids.push(H('Why it could fail', HeadingLevel.HEADING_3));
    kids.push(...prose(failBullets));
  }

  // ── The facts ────────────────────────────────────────────────────────
  const facts = [
    ['Founder', [a.founder_name, a.founder_role].filter(Boolean).join(', ')],
    ['Company', company],
    ['What they do', a.company_one_liner],
    ['Location', [a.location_city, a.location_state].filter(Boolean).join(', ')],
    ['Stage', a.stage],
    ['Round', [money(a.round_size) && `${money(a.round_size)} round`, money(a.valuation) && `${money(a.valuation)} valuation`, a.security_type].filter(Boolean).join(' · ')],
    ['ARR', money(a.arr)],
    ['Website', a.website_url],
  ].filter(([, v]) => v && String(v).trim());
  if (facts.length) {
    kids.push(H('The company', HeadingLevel.HEADING_2));
    kids.push(factTable(facts));
  }

  // ── The 7-M body ─────────────────────────────────────────────────────
  // Recommendation · Management · Model · Market · Momentum · Malfeasance ·
  // Conditions. Exactly the order the house memo uses.
  for (const s of memo7m) {
    kids.push(H(s.title, HeadingLevel.HEADING_2));
    if (s.note) kids.push(P(s.note, { italics: true, color: GREY, size: 19 }));
    kids.push(...prose(s.body));
  }

  // ── Defensibility ────────────────────────────────────────────────────
  if (Array.isArray(defensibility) && defensibility.length) {
    kids.push(H('Defensibility', HeadingLevel.HEADING_2));
    for (const d of defensibility) {
      kids.push(P(d.label, { bold: true, after: 60 }));
      kids.push(...prose(d.body));
    }
  }

  // ── The room ─────────────────────────────────────────────────────────
  // Each lens with its verdict and confidence. Abstentions are printed, not hidden:
  // a lens that honestly declined is information about the evidence.
  if (panel.length) {
    kids.push(H('The room', HeadingLevel.HEADING_2));
    kids.push(P('Nine named lenses read the same materials independently. An abstention means that lens found nothing it could honestly judge on the evidence available.', { italics: true, color: GREY, size: 19 }));
    for (const l of panel) {
      kids.push(P(l.label || l.key, { bold: true, after: 40 }));
      if (l.applies === false) {
        kids.push(P(`Abstained — ${l.abstain_reason || 'no basis on the evidence available'}`, { italics: true, color: GREY, size: 19 }));
        continue;
      }
      const v = flat(l.verdict);
      if (v) kids.push(...prose(v));
      if (l.confidence) kids.push(P(`Confidence: ${l.confidence}`, { color: GREY, size: 19 }));
    }
  }

  // ── Conditions / diligence agenda ────────────────────────────────────
  const priorities = Array.isArray(agenda.top_priorities) ? agenda.top_priorities : [];
  const founderQs = Array.isArray(agenda.founder) ? agenda.founder : [];
  if (priorities.length || founderQs.length) {
    kids.push(H('Conditions — what has to be answered', HeadingLevel.HEADING_2));
    if (priorities.length) {
      kids.push(P('Top priorities', { bold: true, after: 60 }));
      kids.push(...prose(priorities.map(flat).filter(Boolean).map((x) => `- ${x}`).join('\n')));
    }
    if (founderQs.length) {
      kids.push(P('Ask the founder', { bold: true, after: 60 }));
      kids.push(...prose(founderQs.map(flat).filter(Boolean).map((x) => `- ${x}`).join('\n')));
    }
  }

  // ── Sources + honesty ────────────────────────────────────────────────
  kids.push(H('Sources and limits', HeadingLevel.HEADING_2));
  if (sources.length) {
    kids.push(P('What this memo was built from', { bold: true, after: 60 }));
    kids.push(...prose(sources.map((s) => {
      const bits = [s.label || s.file_name || s.input_type, s.source_url].filter(Boolean);
      return `- ${bits.join(' — ')}`;
    }).join('\n')));
  } else {
    kids.push(P('No source documents are recorded on this assessment.', { italics: true, color: GREY }));
  }

  // Quote integrity, straight from agents/verify.js. If the room quoted the
  // materials, the reader is told whether those quotes were found verbatim.
  // quote_integrity is a COUNTS OBJECT from agents/verify.js —
  // {total, verbatim, paraphrased, unverified, has_unverified, has_unsupported_numbers}
  // — not a status string. Comparing it to 'clean' stringified it to "[object
  // Object]", which never equals 'clean', so the memo announced that every lens had
  // failed verification. On this data the truth was 39 of 45 quotes verbatim and
  // ZERO unverified. A false alarm about sourcing, printed in the sourcing section,
  // is worse than printing nothing.
  const integrity = panel.map((l) => l.quote_integrity).filter((x) => x && typeof x === 'object');
  if (integrity.length) {
    const sum = (k) => integrity.reduce((n, x) => n + (Number(x[k]) || 0), 0);
    const total = sum('total');
    const verbatim = sum('verbatim');
    const paraphrased = sum('paraphrased');
    const unverified = sum('unverified');
    kids.push(P('Quote integrity', { bold: true, after: 60 }));
    if (!total) {
      kids.push(P('The room did not quote the source materials directly.', { size: 19 }));
    } else {
      const parts = [`${verbatim} of ${total} quotes verified verbatim against the source materials`];
      if (paraphrased) parts.push(`${paraphrased} paraphrased`);
      if (unverified) parts.push(`${unverified} could NOT be located in the sources — check these before quoting`);
      kids.push(P(`${parts.join(' · ')}.`, { size: 19, bold: unverified > 0 }));
    }
  }

  // The calibration disclaimer is not optional. The score is an evidence-organising
  // prior with no outcome loop behind it, and a memo that presents it as a
  // prediction is the exact failure this product was built to prevent.
  if (conv.calibration) {
    kids.push(P('Calibration', { bold: true, after: 60 }));
    kids.push(P(flat(conv.calibration), { size: 19, color: GREY }));
  }

  kids.push(P(
    'Generated by Stu from the assessment run. Every section above is assembled from that run — no text was re-written for this export. Bracketed [DANNY: …] fields are decisions Stu cannot make.',
    { italics: true, color: GREY, size: 18, after: 0 }
  ));

  return new Document({
    creator: 'Stu — Superior Studios',
    title: `${company} — Investment Memo`,
    description: 'Draft investment memo assembled from a Stu assessment run.',
    sections: [{ properties: {}, children: kids }],
  });
}

async function memoDocxBuffer(a, parts) {
  return Packer.toBuffer(buildMemoDoc(a, parts));
}

module.exports = { buildMemoDoc, memoDocxBuffer, flat };
