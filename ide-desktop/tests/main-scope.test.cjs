'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

/*
 * `electron/main.cjs` cannot be required under `node --test` — it imports the
 * `electron` module — so a reference error inside it is invisible until the app
 * is running and the user clicks the thing.
 *
 * That is exactly how `async switchWorkspace() { await sideChatRestart(); }`
 * shipped: `sideChatRestart` is a method of the object literal it was written
 * inside, so it is NOT in scope as a bare identifier, and every workspace switch
 * died with `ReferenceError: sideChatRestart is not defined`.
 *
 * This is a static check on the file, so the next one fails in the default test
 * run rather than in the running app. It is deliberately narrow: it only looks
 * for a bare call to a name that is defined as a sibling method *and* has no
 * binding anywhere else in the file. Everything else — a genuinely undefined
 * name, a wrong argument — is out of scope.
 */

const mainPath = path.join(__dirname, '..', 'electron', 'main.cjs');
const rawSource = readFileSync(mainPath, 'utf8');

/**
 * Replace comments and string/template literals with spaces, preserving length
 * and line structure so reported line numbers stay correct.
 *
 * Without this, every mention of a name inside a comment or a log message reads
 * as a call — which is how the first version of this check reported the doc
 * comment that explains the fix.
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Keep the newlines so line numbers do not shift.
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === ch) break;
        j += 1;
      }
      const stop = Math.min(j + 1, source.length);
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const code = stripCommentsAndStrings(rawSource);

/** Method names defined inside an object literal, mapped to their line. */
function methodDefinitions(source) {
  const byLine = new Map();
  const names = new Set();
  source.split('\n').forEach((line, index) => {
    const match = /^\s{4}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(line);
    if (match) {
      byLine.set(index, match[1]);
      names.add(match[1]);
    }
  });
  return { byLine, names };
}

/** Every name that has a binding in the file, so a bare use of it is fine. */
function boundNames(source) {
  const names = new Set();
  // function declarations
  for (const m of source.matchAll(/(?:^|\s)(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g)) names.add(m[1]);
  // const/let/var declarations
  for (const m of source.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g)) names.add(m[1]);
  // destructuring
  for (const m of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop()?.trim().replace(/^\.\.\./, '');
      if (name && /^[a-zA-Z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of source.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^\.\.\./, '');
      if (/^[a-zA-Z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // parameters of every function/arrow in the file
  for (const m of source.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[a-zA-Z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // catch (e)
  for (const m of source.matchAll(/catch\s*\(\s*([a-zA-Z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

const GLOBALS = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'globalThis',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'structuredClone', 'fetch', 'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'AbortController',
  'TextDecoder', 'TextEncoder', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'JSON', 'Math', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'Symbol', 'Proxy', 'Reflect', 'Intl', 'BigInt',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Function', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'decodeURI', 'encodeURI', 'escape', 'unescape',
]);

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new',
  'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'yield', 'case', 'super',
  'this', 'class', 'extends', 'instanceof', 'with', 'default',
]);

/** Bare calls to sibling methods, with no binding in scope. The whole check. */
function findBareMethodCalls(source) {
  const { byLine, names: methods } = methodDefinitions(source);
  const bound = boundNames(source);
  const offenders = [];

  source.split('\n').forEach((line, index) => {
    const definedHere = byLine.get(index);
    // A call: an identifier followed by `(`, not preceded by `.` or `?.`.
    for (const match of line.matchAll(/(^|[^\w.$?])([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const name = match[2];
      if (name === definedHere) continue;        // the definition itself
      if (!methods.has(name)) continue;          // not a sibling method → not this bug
      if (bound.has(name)) continue;             // has a real binding somewhere
      if (GLOBALS.has(name) || KEYWORDS.has(name)) continue;
      offenders.push({ name, line: index + 1 });
    }
  });
  return offenders;
}

test('no object-literal method is called as a bare identifier', () => {
  const offenders = findBareMethodCalls(code).map((entry) => `${entry.name} (main.cjs:${entry.line})`);
  assert.deepEqual(
    offenders,
    [],
    `object-literal methods called bare, with no binding in scope: ${offenders.join(', ')}`,
  );
});

test('the check is capable of failing', () => {
  // A guard that cannot fail is not a guard. Prove it fires on the exact shape
  // that shipped broken, stays quiet on the fixed form, and does not read a
  // comment or a string as code.
  const { names: methods } = methodDefinitions(code);
  assert.ok(methods.has('sideChatRestart'), 'sideChatRestart is still a sibling method');
  assert.ok(methods.has('switchWorkspace'), 'so is switchWorkspace');

  // The exact broken shape: a sibling method called bare inside another method.
  const broken = stripCommentsAndStrings(
    '  return {\n    sideChatRestart() {\n      return dropSideChat();\n    },\n' +
    '    async switchWorkspace() {\n      await sideChatRestart();\n    },\n  };',
  );
  const found = findBareMethodCalls(broken);
  assert.deepEqual(found.map((entry) => entry.name), ['sideChatRestart'], 'the broken call is caught');

  // The fixed shape, and a member call, are both clean.
  const fixed = stripCommentsAndStrings(
    '  return {\n    sideChatRestart() {\n      return dropSideChat();\n    },\n' +
    '    async switchWorkspace() {\n      await dropSideChat();\n      await this.sideChatRestart();\n    },\n  };',
  );
  assert.deepEqual(findBareMethodCalls(fixed), [], 'the fix and a member call are both clean');

  // Comments and strings do not read as calls — this is what made the first
  // version of this check report the doc comment explaining the fix.
  assert.deepEqual(findBareMethodCalls(stripCommentsAndStrings('// await sideChatRestart();')), []);
  assert.deepEqual(findBareMethodCalls(stripCommentsAndStrings('log(`sideChatRestart()`)')), []);

  // And the real file is clean.
  assert.deepEqual(
    findBareMethodCalls(code).map((entry) => `${entry.name} (main.cjs:${entry.line})`),
    [],
    'main.cjs has no bare sibling-method call',
  );
});
