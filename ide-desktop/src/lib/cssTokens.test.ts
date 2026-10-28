import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * A guard for undefined CSS custom properties.
 *
 * `src/gui-control.css` carried `color: var(--text-tertiary)` for months. No
 * stylesheet ever defined that token, so the browser dropped the declaration
 * without a word and the label inherited whatever colour its parent happened to
 * have — the same class of silent failure as a typo in a class name, and
 * invisible in review. Nothing in a build or a browser catches it, so scan the
 * sources instead.
 *
 * The scan is deliberately static: it does not evaluate the cascade. A token
 * counts as defined when any `src/**\/*.css` file declares it anywhere, when a
 * component sets it inline (`style={{ '--x': … }}` / `setProperty('--x', …)`),
 * or when the reference carries a fallback (`var(--x, 12px)`), which is a
 * supported form even for a token nobody defines.
 */

const SKIP_DIR = '.mimosa';

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === SKIP_DIR) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (ext.test(entry)) out.push(full);
  }
  return out;
}

/** Blanks out comments while keeping every newline, so line numbers in a
 *  failure message still point at the file the reader has open. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** `--name:` in declaration position — the only place a custom property may be
 *  defined. Matches at the start of a line, or after `{` or `;`, which covers
 *  one-per-line and minified rules alike. */
const DEFINITION = /(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g;

/** `var(--name)` / `var(--name, fallback)`. Group 2 is the comma, i.e. proof
 *  that a fallback exists. */
const REFERENCE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g;

/** A custom property name written as a string literal in TypeScript — the shape
 *  React inline styles and `style.setProperty` both take. */
const INLINE_NAME = /(['"`])(--[A-Za-z0-9_-]+)\1/g;

export type TokenReference = { file: string; line: number; token: string; hasFallback: boolean };

export function collectDefinitions(cssFiles: string[]) {
  const defined = new Set<string>();
  for (const file of cssFiles) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(DEFINITION)) defined.add(match[1]);
  }
  return defined;
}

export function collectReferences(cssFiles: string[], root: string): TokenReference[] {
  const refs: TokenReference[] = [];
  for (const file of cssFiles) {
    const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(REFERENCE)) {
        refs.push({
          file: relative(root, file).split('\\').join('/'),
          line: index + 1,
          token: match[1],
          hasFallback: match[2] === ',',
        });
      }
    });
  }
  return refs;
}

/** Tokens a component writes itself. Not a hand-kept allowlist: the components
 *  are the source of truth, so adding `style={{ '--foo': … }}` does not need a
 *  test edit, and a genuinely dead `var(--foo)` cannot hide behind a stale
 *  exemption that somebody forgot to delete. */
export function collectInlineTokens(sourceFiles: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(INLINE_NAME)) tokens.add(match[2]);
  }
  return tokens;
}

const ROOT = join(process.cwd(), 'src');
const cssFiles = walk(ROOT, /\.css$/);
const sourceFiles = walk(ROOT, /\.(ts|tsx)$/).filter((file) => !/\.test\.(ts|tsx)$/.test(file));

describe('css token guard', () => {
  it('finds stylesheets and component sources to scan', () => {
    // Guards the scanner itself: a broken walk would otherwise "pass" by
    // finding nothing to complain about.
    expect(cssFiles.length).toBeGreaterThanOrEqual(5);
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it('parses definitions and references out of a snippet', () => {
    // Proves the two regexes still see what they are supposed to see.
    const sample = stripComments(':root { --known: 1px; /* --ghost: 2px; */ }\n.a { color: var(--known); border: var(--unknown, 1px); }');
    const defined = [...sample.matchAll(DEFINITION)].map((match) => match[1]);
    const refs = [...sample.matchAll(REFERENCE)].map((match) => ({ token: match[1], fallback: match[2] === ',' }));
    expect(defined).toEqual(['--known']);
    expect(refs).toEqual([
      { token: '--known', fallback: false },
      { token: '--unknown', fallback: true },
    ]);
  });

  it('collects a plausible number of tokens from the real stylesheets', () => {
    const defined = collectDefinitions(cssFiles);
    const refs = collectReferences(cssFiles, ROOT);
    expect(defined.size).toBeGreaterThan(50);
    expect(refs.length).toBeGreaterThan(3000);
  });

  it('never references a custom property that nothing defines', () => {
    const defined = collectDefinitions(cssFiles);
    const inline = collectInlineTokens(sourceFiles);
    const offenders = collectReferences(cssFiles, ROOT).filter((ref) => {
      if (ref.hasFallback) return false; // var(--x, fallback) is safe by definition
      if (defined.has(ref.token)) return false;
      if (inline.has(ref.token)) return false; // set from TSX, see the exemptions below
      return true;
    });

    expect(offenders.map((ref) => `${ref.file}:${ref.line} var(${ref.token})`)).toEqual([]);
  });
});

/*
 * Exemptions, and why each is legitimate rather than dead:
 *
 * Every name below is written by a component at runtime, so the scan above
 * discovers them from the sources rather than from a list in this file. Listed
 * for the reader:
 *
 *   --approval-risk-color  ToolCard.tsx      style={{ '--approval-risk-color': meta.accent }}
 *   --context-pct          Composer.tsx      style={{ '--context-pct': `${rate}%` }}
 *   --pet-sprite-image     PetWidget.tsx     style={{ '--pet-sprite-image': `url(...)` }}
 *   --pet-frame            PetWidget.tsx     style={{ '--pet-frame': frame }}
 *   --pet-scale            PetWidget.tsx     style={{ '--pet-scale': scale }}
 *   --panel-w              App.tsx           style={{ '--panel-w': … }}
 *   --preview-w            App.tsx           style={{ '--preview-w': … }}
 *   --context-w            App.tsx           style={{ '--context-w': … }}
 *   --fs-base / --fs-code  App.tsx           root.style.setProperty, from the font preferences
 *   --font-ui-zh/en/ui      App.tsx          root.style.setProperty, from the font preferences
 *   --bg-image/dim/blur/blur-scale  lib/background.ts  root.style.setProperty
 *   --preview-zoom         Preview/ImagePreview.tsx   style={{ '--preview-zoom': … }}
 *
 * --pet-row and --pet-color are referenced as var(--x, fallback) and so never
 * needed an exemption; --context-pct, --preview-zoom and the font tokens are
 * defined in a stylesheet as well as written from TSX.
 */
describe('exemptions are real', () => {
  it('discovers the tokens the components set themselves', () => {
    const inline = collectInlineTokens(sourceFiles);
    for (const token of [
      '--approval-risk-color',
      '--pet-sprite-image',
      '--pet-frame',
      '--pet-scale',
      '--context-pct',
      '--preview-zoom',
      '--panel-w',
      '--preview-w',
      '--context-w',
      '--fs-base',
      '--fs-code',
      '--font-ui',
      '--bg-image',
    ]) {
      expect(inline.has(token)).toBe(true);
    }
  });
});
