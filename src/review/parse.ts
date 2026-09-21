import { extractBalancedJsonText } from '../providers/protocol.js';

/**
 * The reviewer's structured output, as defined by the rubric's output schema.
 *
 * Every field is optional in the parsed form on purpose: the reviewer is a
 * language model and its JSON is not a contract it can be held to at the type
 * level. The parser's job is to salvage what it can and report honestly what it
 * could not, never to coerce a malformed report into a well-formed one.
 */
export type ReviewFinding = {
  title: string;
  body: string;
  /** 0.0-1.0 as reported. Absent when the reviewer omitted or malformed it. */
  confidenceScore?: number;
  /** 0-3 (P0-P3). Absent when undeterminable. */
  priority?: number;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
};

export type ReviewOutcome = 'correct' | 'incorrect' | 'unknown';

export type ParsedReview = {
  findings: ReviewFinding[];
  outcome: ReviewOutcome;
  explanation?: string;
  overallConfidenceScore?: number;
  /**
   * Set when the reviewer's output could not be parsed as the rubric's schema.
   * `findings` is then empty and `raw` carries the text — an empty finding list
   * from a parse failure is NOT the same as "the reviewer found nothing", and
   * the caller must not present it as a clean review.
   */
  unparsed?: boolean;
  raw?: string;
};

/**
 * Cap on the raw text carried through a parse failure. Enough to show the user
 * what came back, bounded so a runaway response cannot bloat the session file.
 */
export const REVIEW_RAW_CHARS = 8000;

const PRIORITY_LABELS = ['P0', 'P1', 'P2', 'P3'] as const;

/** Render a finding's priority as P0-P3, or undefined when unknown. */
export function priorityLabel(priority: number | undefined): string | undefined {
  if (priority === undefined || !Number.isFinite(priority)) return undefined;
  const clamped = Math.max(0, Math.min(3, Math.trunc(priority)));
  return PRIORITY_LABELS[clamped];
}

/**
 * Strip a leading `[P1]`-style tag from a finding title.
 *
 * The rubric tells the reviewer to tag the title AND set the numeric field, so
 * a title routinely carries both. The UI renders the priority as its own badge;
 * leaving the tag in the title would show it twice.
 */
export function stripPriorityTag(title: string): { title: string; priority?: number } {
  const match = /^\s*\[P([0-3])\]\s*(.*)$/i.exec(title);
  if (!match) return { title: title.trim() };
  return { title: match[2]!.trim(), priority: Number.parseInt(match[1]!, 10) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asUnitNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n > 0 ? n : undefined;
}

function parseFinding(raw: unknown): ReviewFinding | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const rawTitle = asString(record['title']) ?? '';
  const body = asString(record['body']) ?? '';
  // A finding with neither a title nor a body is not reportable — it has no
  // content to show and no location to jump to. Dropping it beats rendering an
  // empty row the user cannot act on.
  if (!rawTitle && !body) return undefined;

  const tagged = stripPriorityTag(rawTitle);
  const explicitPriority = record['priority'];
  const priority = typeof explicitPriority === 'number' && Number.isFinite(explicitPriority)
    ? Math.max(0, Math.min(3, Math.trunc(explicitPriority)))
    : tagged.priority;

  const location = asRecord(record['code_location']);
  const lineRange = asRecord(location?.['line_range']);
  const filePath = asString(location?.['absolute_file_path']);
  const lineStart = asPositiveInt(lineRange?.['start']);
  const lineEnd = asPositiveInt(lineRange?.['end']);

  return {
    title: tagged.title || body.slice(0, 80),
    body,
    ...(asUnitNumber(record['confidence_score']) !== undefined
      ? { confidenceScore: asUnitNumber(record['confidence_score'])! }
      : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(filePath ? { filePath } : {}),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd: lineEnd ?? lineStart } : {}),
  };
}

function parseOutcome(value: unknown): ReviewOutcome {
  const text = asString(value)?.toLowerCase();
  if (!text) return 'unknown';
  // The rubric's literal strings are "patch is correct" / "patch is incorrect".
  // Matching on the substring rather than equality tolerates the trailing
  // punctuation and casing a model adds on its own.
  if (text.includes('incorrect')) return 'incorrect';
  if (text.includes('correct')) return 'correct';
  return 'unknown';
}

/**
 * Parse the reviewer's reply into findings.
 *
 * Uses balanced-brace extraction rather than "first `{` to last `}`": findings
 * contain a nested `code_location` object, and a reply that also quotes JSON
 * from the code under review (common — the reviewer is reading a diff) would be
 * cut wrong by the naive scan.
 */
export function parseReviewOutput(text: string): ParsedReview {
  const candidates = extractBalancedJsonText(text, '{', '}');
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) continue;
    const findingsRaw = record['findings'];
    // The schema's anchor: a review object has a findings array. Without it
    // this is some other JSON the reviewer happened to emit (a diff hunk, an
    // example), not its verdict.
    if (!Array.isArray(findingsRaw)) continue;

    const findings = findingsRaw
      .map(parseFinding)
      .filter((finding): finding is ReviewFinding => finding !== undefined);

    return {
      findings,
      outcome: parseOutcome(record['overall_correctness']),
      ...(asString(record['overall_explanation'])
        ? { explanation: asString(record['overall_explanation'])! }
        : {}),
      ...(asUnitNumber(record['overall_confidence_score']) !== undefined
        ? { overallConfidenceScore: asUnitNumber(record['overall_confidence_score'])! }
        : {}),
    };
  }

  return {
    findings: [],
    outcome: 'unknown',
    unparsed: true,
    raw: text.length > REVIEW_RAW_CHARS ? `${text.slice(0, REVIEW_RAW_CHARS)}\n[已截断]` : text,
  };
}
