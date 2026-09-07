/**
 * languageBridge.ts — Standalone stdin/stdout bridge for editor language
 * intelligence (hover, go-to-definition, find-references, completions) backed
 * by the real TypeScript compiler language service.
 *
 * Launched by the Electron main process as a persistent child; receives
 * newline-delimited JSON requests and replies with newline-delimited JSON.
 *
 * Protocol:
 *   request:  { id, method: 'hover'|'definition'|'references'|'completions',
 *               workspaceRoot, path, line, column }
 *   response: { id, result } | { id, error }
 *   (line/column are 1-based)
 */
import { createInterface } from 'node:readline';
import { hoverAt, definitionAt, referencesAt, completionsAt } from '../language/tsService.js';

type LanguageRequest = {
  id: string;
  method: 'hover' | 'definition' | 'references' | 'completions';
  workspaceRoot: string;
  path: string;
  line: number;
  column: number;
};

function handle(req: LanguageRequest): unknown {
  const { workspaceRoot, path, line, column } = req;
  switch (req.method) {
    case 'hover': return hoverAt(workspaceRoot, path, line, column);
    case 'definition': return definitionAt(workspaceRoot, path, line, column);
    case 'references': return referencesAt(workspaceRoot, path, line, column);
    case 'completions': return completionsAt(workspaceRoot, path, line, column);
    default: throw new Error(`Unknown language method: ${(req as { method: string }).method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let id = 'unknown';
  try {
    const msg = JSON.parse(trimmed) as LanguageRequest;
    id = msg.id;
    const result = handle(msg);
    process.stdout.write(JSON.stringify({ id, result }) + '\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ id, error: message }) + '\n');
  }
});

rl.on('close', () => process.exit(0));

// One bad request must never kill the bridge.
process.on('unhandledRejection', () => {});
