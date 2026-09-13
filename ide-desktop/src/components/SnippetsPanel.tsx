import { useCallback, useEffect, useMemo, useState } from 'react';
import { Code2, Copy, Pencil, Plus, Search, Trash2, Upload, Download, X, Check } from 'lucide-react';
import { desktop, type Snippet, type SnippetInput } from '../lib/ipc';
import { expandTemplate, parseTemplate, type TemplateVariable } from '../lib/templateVars';

/**
 * Iteration 4 — snippets library panel.
 *
 * Full CRUD over the main-process snippets store: search/filter client-side
 * after the backend keyword search, edit in a split form, insert into the
 * composer (via prefill) or copy to clipboard. Import/export round-trips the
 * JSON array the store already understands.
 */

type Draft = SnippetInput & { id?: string };

const EMPTY_DRAFT: Draft = { title: '', language: 'ts', body: '', tags: [], description: '' };

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * Fill-in-the-blanks dialog for snippet bodies that carry {{variables}}.
 * Required vars (no declared default) show a red hint and block insertion
 * until filled; optional ones prefill their fallback.
 */
function TemplateForm({ body, variables, onConfirm, onCancel }: {
  body: string;
  variables: TemplateVariable[];
  onConfirm: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const initial = useMemo(() => {
    const map: Record<string, string> = {};
    for (const v of variables) map[v.name] = v.fallback ?? '';
    return map;
  }, [variables]);
  const [values, setValues] = useState<Record<string, string>>(initial);

  const missing = variables.filter((v) => !v.optional && !(values[v.name] ?? '').trim());
  const preview = expandTemplate(body, values).text;

  return (
    <div className="snip-tpl-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="snip-tpl-panel" role="dialog" aria-modal="true">
        <div className="snip-tpl-head">
          <span>填写模板变量</span>
          <button className="icon-button" onClick={onCancel} title="关闭"><X size={15} /></button>
        </div>
        <div className="snip-tpl-fields">
          {variables.map((v) => (
            <label key={v.name} className="snip-tpl-field">
              <span className="snip-tpl-label">
                {v.name}
                {!v.optional && <em className="snip-tpl-required">必填</em>}
              </span>
              <input
                className="snip-field"
                value={values[v.name] ?? ''}
                placeholder={v.optional ? (v.fallback || '可留空') : ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        <pre className="snip-tpl-preview">{preview}</pre>
        <div className="snip-editor-foot">
          <button
            className="snip-btn snip-btn-primary"
            disabled={missing.length > 0}
            onClick={() => onConfirm(values)}
          >插入</button>
          <button className="snip-btn" onClick={onCancel}>取消</button>
          {missing.length > 0 && <span className="snip-tpl-hint">还差 {missing.map((v) => v.name).join('、')}</span>}
        </div>
      </div>
    </div>
  );
}

export function SnippetsPanel({ onInsert }: { onInsert: (text: string) => void }) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [term, setTerm] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Iteration 5: when a snippet body carries {{variables}}, intercept insert/
  // copy with a fill-in dialog instead of dumping raw placeholders on the user.
  const [tplSnippet, setTplSnippet] = useState<Snippet | null>(null);

  const refresh = useCallback(async (query: string) => {
    try {
      const list = query.trim() ? await desktop.snippets.search(query) : await desktop.snippets.list();
      setSnippets(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(''); }, [refresh]);
  useEffect(() => {
    const t = window.setTimeout(() => { void refresh(term); }, 250);
    return () => window.clearTimeout(t);
  }, [term, refresh]);

  const selected = useMemo(
    () => snippets.find((s) => s.id === selectedId) ?? null,
    [snippets, selectedId],
  );

  async function saveDraft() {
    if (!draft) return;
    setError(null);
    try {
      const tags = tagInput.split(/[,，\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
      const input: SnippetInput = { title: draft.title, language: draft.language, body: draft.body, description: draft.description, tags };
      const saved = draft.id
        ? await desktop.snippets.update(draft.id, input)
        : await desktop.snippets.create(input);
      setDraft(null);
      setTagInput('');
      await refresh(term);
      setSelectedId(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(snippet: Snippet) {
    if (!window.confirm(`删除片段「${snippet.title}」？此操作不可撤销。`)) return;
    try {
      await desktop.snippets.remove(snippet.id);
      if (selectedId === snippet.id) setSelectedId(null);
      await refresh(term);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copy(snippet: Snippet) {
    try {
      await desktop.clipboard.write(snippet.body);
      void desktop.snippets.touch(snippet.id);
      setCopiedId(snippet.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === snippet.id ? null : cur)), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function insert(snippet: Snippet) {
    // Templated snippets open the variable dialog first.
    if (parseTemplate(snippet.body).hasPlaceholders) {
      setTplSnippet(snippet);
      return;
    }
    void desktop.snippets.touch(snippet.id);
    onInsert(snippet.body);
  }

  function confirmTemplate(values: Record<string, string>) {
    if (!tplSnippet) return;
    const expanded = expandTemplate(tplSnippet.body, values).text;
    void desktop.snippets.touch(tplSnippet.id);
    setTplSnippet(null);
    onInsert(expanded);
  }

  async function exportAll() {
    try {
      const json = await desktop.snippets.export();
      await desktop.clipboard.write(json);
      setError(null);
      window.alert('全部片段已复制到剪贴板（JSON）。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function importFromFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await desktop.snippets.import(String(reader.result ?? ''));
        await refresh(term);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="snip-panel">
      <div className="snip-side">
        <div className="snip-search">
          <Search size={14} />
          <input placeholder="搜索片段…" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        <button className="snip-new" onClick={() => { setDraft({ ...EMPTY_DRAFT }); setTagInput(''); setError(null); }}>
          <Plus size={14} /> 新建片段
        </button>
        <div className="snip-list">
          {snippets.length === 0 && <div className="snip-empty">{term ? '没有匹配的片段' : '还没有片段，点上方新建'}</div>}
          {snippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              className={`snip-item${snippet.id === selectedId ? ' active' : ''}`}
              onClick={() => setSelectedId(snippet.id)}
            >
              <span className="snip-item-title">{snippet.title}</span>
              <span className="snip-item-meta">
                <span className="snip-item-lang">{snippet.language}</span>
                <span>{formatWhen(snippet.updatedAt)}</span>
                {snippet.usageCount > 0 && <span className="snip-item-uses">×{snippet.usageCount}</span>}
              </span>
            </button>
          ))}
        </div>
        <div className="snip-io">
          <button className="snip-io-btn" onClick={() => { void exportAll(); }} title="导出为 JSON 到剪贴板"><Download size={13} /> 导出</button>
          <label className="snip-io-btn" title="从 JSON 文件导入（替换全部）"><Upload size={13} /> 导入<input type="file" accept=".json,application/json" hidden onChange={importFromFile} /></label>
        </div>
      </div>
      <div className="snip-main">
        {error && <div className="snip-error">{error}</div>}
        {draft ? (
          <div className="snip-editor">
            <div className="snip-editor-head">
              <span>{draft.id ? '编辑片段' : '新建片段'}</span>
              <button className="icon-button" onClick={() => { setDraft(null); setError(null); }} title="关闭"><X size={15} /></button>
            </div>
            <div className="snip-field-row">
              <input
                className="snip-field snip-field-title"
                placeholder="标题"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
              <input
                className="snip-field snip-field-lang"
                placeholder="语言"
                value={draft.language}
                onChange={(e) => setDraft({ ...draft, language: e.target.value })}
              />
            </div>
            <input
              className="snip-field"
              placeholder="标签（逗号分隔）"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
            />
            <textarea
              className="snip-field snip-field-body"
              placeholder="片段内容…"
              value={draft.body}
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <div className="snip-editor-foot">
              <button className="snip-btn snip-btn-primary" onClick={() => { void saveDraft(); }} disabled={!draft.title.trim()}>保存</button>
              <button className="snip-btn" onClick={() => { setDraft(null); setError(null); }}>取消</button>
            </div>
          </div>
        ) : selected ? (
          <div className="snip-detail">
            <div className="snip-detail-head">
              <h3>{selected.title}</h3>
              <div className="snip-detail-actions">
                <button className="icon-button" title="复制" onClick={() => { void copy(selected); }}>{copiedId === selected.id ? <Check size={15} /> : <Copy size={15} />}</button>
                <button className="icon-button" title="插入到输入框" onClick={() => { void insert(selected); }}><Code2 size={15} /></button>
                <button
                  className="icon-button"
                  title="编辑"
                  onClick={() => {
                    setDraft({ id: selected.id, title: selected.title, language: selected.language, body: selected.body, description: selected.description, tags: selected.tags });
                    setTagInput(selected.tags.join(', '));
                  }}
                ><Pencil size={15} /></button>
                <button className="icon-button" title="删除" onClick={() => { void remove(selected); }}><Trash2 size={15} /></button>
              </div>
            </div>
            {selected.description && <p className="snip-detail-desc">{selected.description}</p>}
            {selected.tags.length > 0 && (
              <div className="snip-tags">{selected.tags.map((t) => <span key={t} className="snip-tag">{t}</span>)}</div>
            )}
            <pre className="snip-detail-body"><code>{selected.body}</code></pre>
            <div className="snip-detail-meta">
              {selected.language} · 更新于 {formatWhen(selected.updatedAt)} · 使用 {selected.usageCount} 次
            </div>
          </div>
        ) : (
          <div className="snip-placeholder">
            <Code2 size={28} />
            <p>选择一个片段查看详情，或新建一个。</p>
          </div>
        )}
      </div>
      {tplSnippet && (
        <TemplateForm
          body={tplSnippet.body}
          variables={parseTemplate(tplSnippet.body).variables}
          onConfirm={confirmTemplate}
          onCancel={() => setTplSnippet(null)}
        />
      )}
    </div>
  );
}
