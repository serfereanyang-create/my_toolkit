import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * A guard for the two ways a component can pass a legacy string `ref`, both of
 * which crash at runtime and neither of which TypeScript catches on a custom
 * component:
 *
 *   <FileLevel ref="8d4c17f" />            → React error #290
 *   <div ref="thing" />                    → same class of failure
 *
 * This bit us for real: the inspector's file level named a commit prop `ref`,
 * so drilling 提交图谱 → commit → file threw "Element ref was specified as a
 * string" and blanked the whole window. The dev server would have shown it
 * immediately; the built app only shows a minified code. So scan the sources.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

describe('no string refs anywhere in the renderer', () => {
  const files = walk(join(process.cwd(), 'src'));

  it('finds component sources to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('never passes a literal string as a ref attribute', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // ref="..." / ref='...' — a string literal, which React treats as a
      // legacy string ref.
      if (/\bref\s*=\s*["']/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('does not declare a prop named `ref` on a component', () => {
    // A prop literally named `ref` shadows React's reserved attribute, so a
    // caller passing a string lands on the legacy path.
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // `ref?: type` or `ref: type` inside a props object/type literal.
      if (/^\s*ref\??\s*:/m.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
