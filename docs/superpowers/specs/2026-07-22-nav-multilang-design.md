# Multi-language Navigation Heuristics

Date: 2026-07-22

## Goal

Extend the heuristic symbol index beyond TS/JS to Python, Go, Rust, and Java/Kotlin so `find_symbol` / `find_references` work in mixed polyglot workspaces without an LSP server.

## Scope

- Heuristic line-based extractors only (no full parsers)
- Index version stays `1`; language tag expands
- Same ignore dirs; same max file count/size
- Existing TS/JS behavior unchanged

## Languages

| Ext | language | Symbols |
| --- | --- | --- |
| .ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs | ts/js | existing |
| .py | python | def, class, async def |
| .go | go | func, type, const, var |
| .rs | rust | fn, struct, enum, trait, impl, mod |
| .java/.kt/.kts | java/kotlin | class, interface, enum, fun, object |

## Non-goals

- True scope/endLine accuracy
- LSP protocol
- C/C++ macros
