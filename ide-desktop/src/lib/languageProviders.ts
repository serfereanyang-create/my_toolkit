/**
 * languageProviders.ts — Real TypeScript language intelligence for Monaco.
 *
 * Registers hover / go-to-definition / find-references providers backed by the
 * language-server bridge (which wraps the actual TypeScript compiler). This
 * makes the editor behave like a real IDE: Ctrl+hover shows types, Ctrl+click
 * jumps to definitions, right-click Find All References works across files.
 *
 * Only registered for typescript/javascript files. Other languages fall back to
 * Monaco's built-in single-file workers (if any).
 */

import type * as Monaco from 'monaco-editor';
import { desktop } from './ipc';
import type { LanguageRange } from './ipc';

let workspaceRoot = '';

export function setLanguageWorkspaceRoot(root: string) {
  workspaceRoot = root;
}

function toMonacoRange(monaco: typeof Monaco, range: LanguageRange): Monaco.IRange {
  return new monaco.Range(range.line, range.column, range.endLine, range.endColumn);
}

function toMonacoPosition(monaco: typeof Monaco, line: number, column: number): Monaco.Position {
  return new monaco.Position(line, column);
}

export function registerLanguageProviders(monaco: typeof Monaco, model: Monaco.editor.ITextModel) {
  const lang = model.getLanguageId();
  if (lang !== 'typescript' && lang !== 'javascript') return;

  const disposables: Monaco.IDisposable[] = [];

  // Hover provider — shows type info on Ctrl+hover or hover delay
  disposables.push(
    monaco.languages.registerHoverProvider([lang], {
      async provideHover(model, position) {
        const result = await desktop.language.hover({
          workspaceRoot,
          path: model.uri.fsPath,
          line: position.lineNumber,
          column: position.column,
        });
        if (!result.ok || !result.result) return null;
        const { type, documentation, range } = result.result;
        const contents = [
          { value: `\`\`\`typescript\n${type}\n\`\`\`` },
          documentation ? { value: documentation } : undefined,
        ].filter(Boolean) as Monaco.IMarkdownString[];
        return { contents, range: toMonacoRange(monaco, range) };
      },
    })
  );

  // Definition provider — Ctrl+click / F12 jumps to definition
  disposables.push(
    monaco.languages.registerDefinitionProvider([lang], {
      async provideDefinition(model, position) {
        const result = await desktop.language.definition({
          workspaceRoot,
          path: model.uri.fsPath,
          line: position.lineNumber,
          column: position.column,
        });
        if (!result.ok || !result.result?.length) return null;
        return result.result.map((def) => ({
          uri: monaco.Uri.file(def.path),
          range: toMonacoRange(monaco, def.range),
        }));
      },
    })
  );

  // References provider — right-click Find All References / Shift+F12
  disposables.push(
    monaco.languages.registerReferenceProvider([lang], {
      async provideReferences(model, position, context) {
        const result = await desktop.language.references({
          workspaceRoot,
          path: model.uri.fsPath,
          line: position.lineNumber,
          column: position.column,
        });
        if (!result.ok || !result.result?.length) return null;
        // context.includeDeclaration controls whether the definition itself is included
        return result.result
          .filter((ref) => context.includeDeclaration || !ref.isDefinition)
          .map((ref) => ({
            uri: monaco.Uri.file(ref.path),
            range: toMonacoRange(monaco, ref.range),
          }));
      },
    })
  );

  // Completion provider — type-aware suggestions (not ghost text; this is the dropdown list)
  disposables.push(
    monaco.languages.registerCompletionItemProvider([lang], {
      async provideCompletionItems(model, position) {
        const result = await desktop.language.completions({
          workspaceRoot,
          path: model.uri.fsPath,
          line: position.lineNumber,
          column: position.column,
        });
        if (!result.ok || !result.result?.length) return { suggestions: [] };
        
        // Map TS compiler 'kind' to Monaco CompletionItemKind
        const kindMap: Record<string, Monaco.languages.CompletionItemKind> = {
          method: monaco.languages.CompletionItemKind.Method,
          function: monaco.languages.CompletionItemKind.Function,
          constructor: monaco.languages.CompletionItemKind.Constructor,
          field: monaco.languages.CompletionItemKind.Field,
          variable: monaco.languages.CompletionItemKind.Variable,
          class: monaco.languages.CompletionItemKind.Class,
          struct: monaco.languages.CompletionItemKind.Struct,
          interface: monaco.languages.CompletionItemKind.Interface,
          module: monaco.languages.CompletionItemKind.Module,
          property: monaco.languages.CompletionItemKind.Property,
          event: monaco.languages.CompletionItemKind.Event,
          operator: monaco.languages.CompletionItemKind.Operator,
          unit: monaco.languages.CompletionItemKind.Unit,
          value: monaco.languages.CompletionItemKind.Value,
          constant: monaco.languages.CompletionItemKind.Constant,
          enum: monaco.languages.CompletionItemKind.Enum,
          enumMember: monaco.languages.CompletionItemKind.EnumMember,
          keyword: monaco.languages.CompletionItemKind.Keyword,
          text: monaco.languages.CompletionItemKind.Text,
          color: monaco.languages.CompletionItemKind.Color,
          file: monaco.languages.CompletionItemKind.File,
          reference: monaco.languages.CompletionItemKind.Reference,
          customcolor: monaco.languages.CompletionItemKind.Customcolor,
          folder: monaco.languages.CompletionItemKind.Folder,
          typeParameter: monaco.languages.CompletionItemKind.TypeParameter,
          snippet: monaco.languages.CompletionItemKind.Snippet,
        };

        const suggestions: Monaco.languages.CompletionItem[] = result.result.map((item) => ({
          label: item.label,
          kind: kindMap[item.kind] ?? monaco.languages.CompletionItemKind.Text,
          detail: item.detail,
          insertText: item.insertText,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
        }));

        return { suggestions };
      },
    })
  );

  return () => disposables.forEach((d) => d.dispose());
}
