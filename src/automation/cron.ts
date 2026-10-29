/**
 * Cron expression validation for the automation scheduler.
 *
 * The scheduler forwards `trigger.expression` to a host integration
 * (`CronAutomationProvider.create`). That call used to be made with whatever
 * the task carried: the probe fed it `'not a cron'`, `'99 99 * * *'`,
 * `'* * * *'` (four fields) and a zero step, and every one of them was
 * accepted and registered — a schedule the host can never fire, persisted as
 * an enabled task. A typo has to be reported at `create`/`start` time, not
 * silently turned into "never runs".
 *
 * Scope: the conventional 5-field syntax every host in use here accepts
 * (minute hour day-of-month month day-of-week). Each field is a comma list of
 * `*`, `a`, `a-b`, a step on `*` or on a range (and `a/n`, which cronie treats
 * as `a-max/n`); month and day-of-week also take the usual three-letter names.
 * Six/seven-field (seconds, year) and special strings (`@daily`) are refused
 * on purpose rather than half-supported: the built-in templates and docs only
 * use five fields, and accepting a shape the host may interpret differently is
 * how a task ends up firing at the wrong minute.
 */

type FieldSpec = { name: string; min: number; max: number; names?: Record<string, number> };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  { name: 'day of week', min: 0, max: 7, names: DAYS },
];

/** Parse one field value: number, or a three-letter name for month/dow. */
function parseValue(raw: string, spec: FieldSpec): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (spec.names && text in spec.names) return spec.names[text]!;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) return null;
  return value;
}

/** True when `raw` is a legal step (`n`, n >= 1). */
function validStep(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  if (!/^\d+$/.test(raw)) return false;
  return Number(raw) >= 1;
}

function fieldInvalidReason(field: string, spec: FieldSpec): string | null {
  const where = `${spec.name} field "${field}"`;
  if (field.trim() === '') return `${where} is empty`;
  for (const part of field.split(',')) {
    if (part.trim() === '') return `${where} has an empty list element`;
    const slash = part.indexOf('/');
    const body = slash >= 0 ? part.slice(0, slash) : part;
    const step = slash >= 0 ? part.slice(slash + 1) : undefined;
    if (!validStep(step)) return `${where}: step must be an integer >= 1`;
    if (body === '*') continue;
    const dash = body.indexOf('-');
    if (dash >= 0) {
      const from = parseValue(body.slice(0, dash), spec);
      const to = parseValue(body.slice(dash + 1), spec);
      if (from === null || to === null) {
        return `${where}: range must be ${spec.min}-${spec.max}` + (spec.names ? ' (or names)' : '');
      }
      // A descending range (`5-1`) is not refused: cronie accepts it (and
      // `0 0 * * fri-mon` is a real weekend schedule in the wild), and the
      // expression is going to cronie, not to a parser of ours.
      continue;
    }
    if (parseValue(body, spec) === null) {
      return `${where}: value must be ${spec.min}-${spec.max}` + (spec.names ? ' (or a name)' : '');
    }
  }
  return null;
}

/**
 * `null` when the expression is a usable 5-field cron schedule, otherwise the
 * reason it is not. The message names the field so the user can fix it.
 */
export function validateCronExpression(expression: string): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return 'cron expression is empty';
  if (trimmed.startsWith('@')) {
    return `cron aliases ("${trimmed}") are not supported; use a 5-field expression`;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== FIELDS.length) {
    return `cron expression must have ${FIELDS.length} fields (minute hour day-of-month month day-of-week), got ${parts.length}`;
  }
  for (let index = 0; index < FIELDS.length; index += 1) {
    const reason = fieldInvalidReason(parts[index]!, FIELDS[index]!);
    if (reason) return reason;
  }
  return null;
}
