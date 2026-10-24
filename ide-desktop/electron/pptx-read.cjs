/*
 * Read a .pptx presentation into slide summaries for the preview pane.
 *
 * A presentation is not a document: it has no single linear content stream to
 * render, and reproducing PowerPoint's layout engine (placeholders, masters,
 * theme fonts, autofit) is a project of its own. So this does what a preview
 * pane actually needs — it extracts the text a reader would look at, in slide
 * order, and groups it by placeholder — and the pane renders that as a deck of
 * slide cards. The shape tree is walked in document order, which is the order
 * the shapes are painted in; for the decks the CLI writes, and for anything
 * built from a normal template, the title placeholder comes first.
 *
 * Slide order comes from `ppt/presentation.xml` + its relationships, NOT from
 * the part filenames: `slide3.xml` is not reliably the third slide once a deck
 * has been reordered in PowerPoint, and reading the files in name order would
 * silently scramble the deck.
 *
 * Speaker notes are read too. They are what a presenter previewing their own
 * deck most wants to check, and they live in a sibling part that is cheap to
 * pull in.
 */

const { readZipEntries, decodeXmlText, findEntry } = require('./zip-read.cjs');

// A preview shows a deck, not an archive. A 500-slide deck is still previewable;
// a thousand is a sign something else is going on.
const MAX_SLIDES = 300;
const MAX_SHAPES_PER_SLIDE = 200;
const MAX_PARAGRAPHS_PER_SHAPE = 200;
const MAX_ROWS = 200;      // table rows kept per table
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/** `a:p` paragraphs inside one shape's `p:txBody`, as plain strings. */
function paragraphsFromTextBody(body) {
  const paragraphs = [];
  for (const match of body.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>|<a:p\b[^>]*\/>/g)) {
    const inner = match[1] ?? '';
    // A paragraph's text is the concatenation of its runs; `<a:br/>` is a line
    // break within the paragraph and reads as a space here.
    const text = [...inner.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
      .map((run) => decodeXmlText(run[1]))
      .join('');
    const level = Number.parseInt(/\blvl="(\d+)"/.exec(inner)?.[1] ?? '0', 10);
    if (text.trim()) paragraphs.push({ text, level: Number.isFinite(level) ? level : 0 });
    if (paragraphs.length >= MAX_PARAGRAPHS_PER_SHAPE) break;
  }
  return paragraphs;
}

/** A table's cells, flattened to rows of text. Tables carry real content in decks. */
function tableRows(body) {
  if (!body.includes('<a:tbl>') && !body.includes('<a:tbl ')) return null;
  const table = /<a:tbl\b[\s\S]*?<\/a:tbl>/.exec(body)?.[0];
  if (!table) return null;
  const rows = [];
  for (const rowMatch of table.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
    const cells = [...rowMatch[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((cell) =>
      paragraphsFromTextBody(cell[1]).map((p) => p.text).join(' ').trim());
    rows.push(cells);
    if (rows.length >= MAX_ROWS) break;
  }
  return rows.length ? rows : null;
}

/**
 * The shapes on one slide, in document order.
 *
 * A placeholder type is carried through so the pane can tell a title from body
 * text, and used by the fallback below when a deck has no explicit title.
 */
function parseSlide(xml) {
  const shapes = [];
  // `p:sp` is a text shape, `p:pic` a picture, `p:graphicFrame` a table or chart.
  const shapeRe = /<p:(sp|pic|graphicFrame)\b[^>]*>([\s\S]*?)<\/p:\1>/g;
  let match;
  while ((match = shapeRe.exec(xml)) !== null) {
    const kind = match[1];
    const body = match[2];
    if (kind === 'pic') { shapes.push({ kind: 'picture', paragraphs: [] }); continue; }

    const type = /\btype="([^"]+)"/.exec(/<p:ph\b([^>]*)\/?>/.exec(body)?.[1] ?? '')?.[1] ?? '';
    const table = tableRows(body);
    // A table's cells ARE text bodies, so the paragraph scan would return the
    // whole table flattened as well. Emitting both would render every cell
    // twice — once in the grid, once as a list under it.
    const paragraphs = table ? [] : paragraphsFromTextBody(body);
    if (!paragraphs.length && !table) continue;
    shapes.push({ kind: table ? 'table' : 'text', type, paragraphs, table: table ?? undefined });
    if (shapes.length >= MAX_SHAPES_PER_SLIDE) break;
  }
  return shapes;
}

/**
 * A slide's notes text, found through the slide's relationship part.
 *
 * `ppt/slides/_rels/slide2.xml.rels` carries the `notesSlide` relationship; the
 * target's filename number has no relation to the slide's position.
 */
function notesPartFor(entries, slideTarget) {
  const relsPath = `ppt/${slideTarget.replace(/^slides\//, 'slides/_rels/')}.rels`;
  const rels = findEntry(entries, relsPath);
  if (!rels) return '';
  const match = /Target="([^"]*notesSlide\d+\.xml)"/.exec(rels.toString('utf8'));
  if (!match) return '';
  const target = match[1].replace(/^\/?ppt\//, '').replace(/^\//, '').replace(/^\.\.\//, '');
  const part = findEntry(entries, `ppt/${target}`, target);
  return part ? part.toString('utf8') : '';
}

/** Speaker notes for a slide part, joined into one string. */
function parseNotes(xml) {
  if (!xml) return '';
  const texts = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlText(m[1]));
  // The notes slide number placeholder renders as a bare digit; drop it.
  return texts.filter((t) => t.trim() && !/^\d+$/.test(t.trim())).join('\n').trim();
}

/**
 * Parse a presentation.
 *
 * Returns `{ ok: true, slides, truncated }` or `{ ok: false, error }`, with each
 * slide as `{ index, title, shapes, notes, hasPicture }`.
 */
function parsePptx(buffer) {
  let entries;
  try {
    entries = readZipEntries(buffer, { maxInflatedBytes: MAX_INFLATED_BYTES });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (entries.size === 0) return { ok: false, error: '演示文稿为空或无法解压' };

  // rId → slide part, from the presentation's relationship part.
  const relsXml = findEntry(entries, 'ppt/_rels/presentation.xml.rels', '_rels/presentation.xml.rels');
  const relTargets = new Map();
  if (relsXml) {
    for (const match of relsXml.toString('utf8').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
      if (id && target) relTargets.set(id, target.replace(/^\/?ppt\//, '').replace(/^\//, ''));
    }
  }

  // Slide order, from p:sldIdLst. This is the whole reason the part names are
  // not used directly.
  const presentationXml = findEntry(entries, 'ppt/presentation.xml', 'presentation.xml');
  const ordered = [];
  if (presentationXml) {
    for (const match of presentationXml.toString('utf8').matchAll(/<p:sldId\b([^>]*)\/?>/g)) {
      const rid = /\br:id="([^"]+)"/.exec(match[1])?.[1];
      const target = rid ? relTargets.get(rid) : undefined;
      if (target) ordered.push(target);
      if (ordered.length >= MAX_SLIDES) break;
    }
  }

  // No presentation.xml (or unreadable relationships): fall back to the
  // worksheet-style name order, which is at least deterministic.
  if (ordered.length === 0) {
    for (const name of [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))) {
      ordered.push(name.replace(/^ppt\//, ''));
    }
    ordered.sort((a, b) => {
      const na = Number.parseInt(/\d+/.exec(a)?.[0] ?? '0', 10);
      const nb = Number.parseInt(/\d+/.exec(b)?.[0] ?? '0', 10);
      return na - nb;
    });
  }

  const slides = [];
  let truncated = ordered.length >= MAX_SLIDES;
  for (const target of ordered.slice(0, MAX_SLIDES)) {
    const part = findEntry(entries, `ppt/${target}`, target);
    if (!part) continue;
    const xml = part.toString('utf8');
    const shapes = parseSlide(xml);

    // The title: an explicit title placeholder if there is one, else the first
    // non-empty text on the slide. A deck whose title placeholder is empty but
    // whose body starts with a heading should still be listed under that heading
    // rather than as "第 N 页".
    const titleShape = shapes.find((s) => s.type === 'ctrTitle')
      ?? shapes.find((s) => s.type === 'title')
      ?? shapes.find((s) => s.kind === 'text' && s.paragraphs.length);
    const title = titleShape?.paragraphs?.[0]?.text?.trim() ?? '';

    // Notes: resolved through the slide's OWN relationships, not by rewriting
    // the slide filename. `notesSlide1.xml` is the notes for whichever slide
    // links to it, which is usually NOT slide1 — PowerPoint numbers notes parts
    // in creation order, so a deck whose second slide got notes first has its
    // notes in notesSlide1. Matching on the number silently attached the notes
    // to the wrong slide (or dropped them) with no error at all.
    const notesTarget = notesPartFor(entries, target);
    const notes = parseNotes(notesTarget);

    slides.push({
      index: slides.length + 1,
      title,
      shapes,
      notes,
      hasPicture: shapes.some((s) => s.kind === 'picture'),
      // Distinguishing the title shape matters for rendering: the pane can drop
      // it from the body so the heading is not printed twice.
      titleShapeIndex: titleShape ? shapes.indexOf(titleShape) : -1,
    });
  }

  if (slides.length === 0) return { ok: false, error: '演示文稿里没有可读的幻灯片' };
  return { ok: true, slides, truncated };
}

module.exports = { parsePptx, MAX_SLIDES };
