import { useEffect, useMemo, useState } from 'react';
import { Boxes, Eye, EyeOff, Pencil, Plus, Trash2, Check, X, Plug, Loader2 } from 'lucide-react';
import type { ApiFormat, CustomModel, DesktopSettings, ProviderConfig } from '../../types';
import { desktop } from '../../lib/ipc';
import type { ConnectivityResult } from '../../lib/ipc';
import { SelectPill, TextField, EmptyState } from './controls';

/*
 * 模型设置 — manage custom model providers. Each custom provider has a base URL,
 * a wire format (OpenAI /chat/completions or Anthropic /messages), an encrypted
 * API key, and a catalog of selectable models. Everything persists through the
 * normal settings store (providers array) + secret store (per-provider key).
 */

const API_FORMAT_OPTIONS: { value: ApiFormat; label: string }[] = [
  { value: 'openai-chat', label: 'OpenAI Chat (/chat/completions)' },
  { value: 'openai-responses', label: 'OpenAI Responses (/responses)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages (/messages)' },
  { value: 'gemini-generative', label: 'Gemini Generative (/generateContent)' },
];

const VENDOR_OPTIONS = [
  { value: 'custom', label: '自定义' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Gemini / Google' },
  { value: 'xai', label: 'Grok / xAI' },
  { value: 'zhipu', label: 'GLM / 智谱' },
  { value: 'moonshot', label: 'Kimi / Moonshot' },
  { value: 'deepseek', label: 'DeepSeek' },
] as const;

function newProviderId() {
  return `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function isCustom(p: ProviderConfig) {
  return p.type === 'custom';
}

export function ModelSettings({ settings, onSave, onSaveKey }: {
  settings: DesktopSettings;
  onSave: (settings: DesktopSettings) => void;
  onSaveKey: (providerId: string, apiKey: string) => Promise<void>;
}) {
  const customProviders = useMemo(() => settings.providers.filter(isCustom), [settings.providers]);
  const [activeId, setActiveId] = useState<string>(customProviders[0]?.id ?? '');

  // Keep a valid selection as the provider list changes.
  useEffect(() => {
    if (!customProviders.some((p) => p.id === activeId)) {
      setActiveId(customProviders[0]?.id ?? '');
    }
  }, [customProviders, activeId]);

  const active = customProviders.find((p) => p.id === activeId) ?? null;

  function updateProvider(id: string, patch: Partial<ProviderConfig>) {
    onSave({
      ...settings,
      providers: settings.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  }

  function addProvider() {
    const id = newProviderId();
    const provider: ProviderConfig = {
      id,
      type: 'custom',
      label: '新供应商',
      model: '',
      baseUrl: '',
      apiFormat: 'openai-chat',
      models: [],
    };
    onSave({ ...settings, providers: [...settings.providers, provider] });
    setActiveId(id);
  }

  function removeProvider(id: string) {
    const remaining = settings.providers.filter((p) => p.id !== id);
    // If the removed provider was active for chat, fall back to the first one.
    const activeProviderId = settings.activeProviderId === id
      ? (remaining[0]?.id ?? '')
      : settings.activeProviderId;
    onSave({ ...settings, providers: remaining, activeProviderId });
  }

  return (
    <div className="settings-page model-settings">
      <h1 className="settings-page-title">模型设置</h1>
      <p className="settings-page-subtitle">管理自定义模型供应商，配置后可在聊天时选择使用。</p>

      <div className="model-settings-body">
        <aside className="model-provider-rail">
          <div className="model-provider-rail-head">自定义供应商</div>
          <div className="model-provider-list">
            {customProviders.map((provider) => (
              <button
                key={provider.id}
                className={`model-provider-item ${provider.id === activeId ? 'active' : ''}`}
                onClick={() => setActiveId(provider.id)}
                title={provider.label}
              >
                <Boxes size={16} className="model-provider-icon" />
                <span className="model-provider-name">{provider.label || '未命名'}</span>
                <span className={`model-provider-dot ${provider.baseUrl ? 'on' : 'off'}`} />
              </button>
            ))}
          </div>
          <button className="model-provider-add" onClick={addProvider}>
            <Plus size={15} /><span>添加供应商</span>
          </button>
        </aside>

        <section className="model-provider-detail">
          {!active ? (
            <EmptyState
              title="尚无自定义供应商"
              description="点击左下角“添加供应商”开始配置。"
            />
          ) : (
            <ProviderDetail
              key={active.id}
              provider={active}
              isActiveForChat={settings.activeProviderId === active.id}
              onChange={(patch) => updateProvider(active.id, patch)}
              onSaveKey={onSaveKey}
              onRemove={() => removeProvider(active.id)}
              onUseForChat={() => onSave({ ...settings, activeProviderId: active.id })}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function ProviderDetail({ provider, isActiveForChat, onChange, onSaveKey, onRemove, onUseForChat }: {
  provider: ProviderConfig;
  isActiveForChat: boolean;
  onChange: (patch: Partial<ProviderConfig>) => void;
  onSaveKey: (providerId: string, apiKey: string) => Promise<void>;
  onRemove: () => void;
  onUseForChat: () => void;
}) {
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectivityResult | null>(null);
  const models = provider.models ?? [];

  async function saveKey() {
    if (!keyInput.trim()) return;
    await onSaveKey(provider.id, keyInput.trim());
    setKeyInput('');
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      // The main process resolves this provider's saved key and sends one real
      // request, so the result reflects the exact config chat will use.
      const result = await desktop.connectivity.test(provider.id);
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  }

  function setModels(next: CustomModel[]) {
    // Keep provider.model (the chat default) pointing at a model that exists.
    const stillThere = next.some((m) => m.id === provider.model);
    onChange({ models: next, model: stillThere ? provider.model : (next[0]?.id ?? '') });
  }

  function addModel(model: CustomModel) {
    if (!model.id.trim()) return;
    if (models.some((m) => m.id === model.id.trim())) return;
    setModels([...models, model]);
  }

  return (
    <div className="provider-detail">
      <div className="provider-detail-head">
        <TextField
          value={provider.label}
          onChange={(label) => onChange({ label })}
          placeholder="供应商名称"
        />
        <div className="provider-detail-head-actions">
          {isActiveForChat
            ? <span className="provider-active-badge"><Check size={13} /> 当前使用</span>
            : <button className="settings-action-btn" onClick={onUseForChat}>用于聊天</button>}
          <button className="settings-icon-btn" aria-label="删除供应商" onClick={onRemove}><Trash2 size={16} /></button>
        </div>
      </div>

      <label className="model-field">
        <span className="model-field-label">Base URL</span>
        <TextField
          value={provider.baseUrl}
          onChange={(baseUrl) => onChange({ baseUrl })}
          placeholder="https://api.example.com/v1"
        />
      </label>

      <label className="model-field">
        <span className="model-field-label">API 格式</span>
        <SelectPill
          value={provider.apiFormat === 'openai' ? 'openai-chat' : provider.apiFormat === 'anthropic' ? 'anthropic-messages' : (provider.apiFormat ?? 'openai-chat')}
          onChange={(apiFormat) => onChange({ apiFormat: apiFormat as ApiFormat })}
          options={API_FORMAT_OPTIONS}
        />
      </label>

      <label className="model-field">
        <span className="model-field-label">API Key</span>
        <div className="model-key-row">
          <input
            className="settings-text-field"
            type={showKey ? 'text' : 'password'}
            value={keyInput}
            placeholder={provider.keyHint && provider.keyHint !== 'missing' ? `已保存 (${provider.keyHint})` : '输入 API Key'}
            onChange={(event) => setKeyInput(event.target.value)}
          />
          <button className="settings-icon-btn" aria-label="显示/隐藏" onClick={() => setShowKey((v) => !v)}>
            {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button className="settings-action-btn" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
            {keySaved ? '已保存' : '保存'}
          </button>
        </div>
      </label>

      <div className="model-field">
        <div className="model-conn-row">
          <button className="settings-action-btn" onClick={() => void testConnection()} disabled={testing}>
            {testing ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
            <span>{testing ? '测试中…' : '测试连接'}</span>
          </button>
          {testResult && (
            <span className={`model-conn-result ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.ok ? <Check size={14} /> : <X size={14} />}
              <span className="model-conn-msg">
                {testResult.message}
                {typeof testResult.latencyMs === 'number' && testResult.latencyMs > 0 ? ` (${testResult.latencyMs}ms)` : ''}
              </span>
            </span>
          )}
        </div>
        {testResult?.ok && testResult.sample && (
          <div className="model-conn-sample">模型回复：{testResult.sample}</div>
        )}
      </div>

      <div className="model-list-block">
        <div className="model-field-label">模型列表</div>
        {models.length === 0 ? (
          <EmptyState title="尚无模型" description="添加模型后即可在聊天中选择。" />
        ) : (
          <div className="model-list">
            {models.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                isDefault={provider.model === m.id}
                onSetDefault={() => onChange({ model: m.id })}
                onEdit={(next) => setModels(models.map((x) => (x.id === m.id ? next : x)))}
                onDelete={() => setModels(models.filter((x) => x.id !== m.id))}
              />
            ))}
          </div>
        )}
        <AddModelButton onAdd={addModel} />
      </div>
    </div>
  );
}

function ModelRow({ model, isDefault, onSetDefault, onEdit, onDelete }: {
  model: CustomModel;
  isDefault: boolean;
  onSetDefault: () => void;
  onEdit: (next: CustomModel) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState(model.id);
  const [ctx, setCtx] = useState(model.contextWindow ? String(model.contextWindow) : '');
  const [inputPrice, setInputPrice] = useState(model.inputPricePerM ? String(model.inputPricePerM) : '');
  const [outputPrice, setOutputPrice] = useState(model.outputPricePerM ? String(model.outputPricePerM) : '');
  const [cacheReadPrice, setCacheReadPrice] = useState(model.cacheReadPricePerM ? String(model.cacheReadPricePerM) : '');
  const [cacheWritePrice, setCacheWritePrice] = useState(model.cacheWritePricePerM ? String(model.cacheWritePricePerM) : '');

  function commit() {
    if (!id.trim()) return;
    onEdit({
      id: id.trim(),
      contextWindow: ctx.trim() ? Number(ctx) : undefined,
      inputPricePerM: inputPrice.trim() ? Number(inputPrice) : undefined,
      outputPricePerM: outputPrice.trim() ? Number(outputPrice) : undefined,
      cacheReadPricePerM: cacheReadPrice.trim() ? Number(cacheReadPrice) : undefined,
      cacheWritePricePerM: cacheWritePrice.trim() ? Number(cacheWritePrice) : undefined,
    });
    setEditing(false);
  }

  const hasPrice = typeof model.inputPricePerM === 'number' || typeof model.outputPricePerM === 'number'
    || typeof model.cacheReadPricePerM === 'number' || typeof model.cacheWritePricePerM === 'number';

  if (editing) {
    return (
      <div className="model-row editing model-row-priced">
        <div className="model-edit-wrapper">
          <div className="model-edit-grid-simple">
            <input className="settings-text-field" value={id} onChange={(e) => setId(e.target.value)} placeholder="模型 ID" />
            <input className="settings-text-field" value={ctx} onChange={(e) => setCtx(e.target.value)} placeholder="上下文 (如 128000)" />
            <input className="settings-text-field" value={inputPrice} onChange={(e) => setInputPrice(e.target.value)} placeholder="输入 $/1M" type="number" min="0" step="0.01" />
            <input className="settings-text-field" value={outputPrice} onChange={(e) => setOutputPrice(e.target.value)} placeholder="输出 $/1M" type="number" min="0" step="0.01" />
            <input className="settings-text-field" value={cacheReadPrice} onChange={(e) => setCacheReadPrice(e.target.value)} placeholder="缓存读 $/1M" type="number" min="0" step="0.01" />
            <input className="settings-text-field" value={cacheWritePrice} onChange={(e) => setCacheWritePrice(e.target.value)} placeholder="缓存写 $/1M" type="number" min="0" step="0.01" />
          </div>
          <div className="model-edit-actions">
            <button className="settings-icon-btn" aria-label="确认" onClick={commit}><Check size={16} /></button>
            <button className="settings-icon-btn" aria-label="取消" onClick={() => { setEditing(false); setId(model.id); setCtx(model.contextWindow ? String(model.contextWindow) : ''); setInputPrice(model.inputPricePerM ? String(model.inputPricePerM) : ''); setOutputPrice(model.outputPricePerM ? String(model.outputPricePerM) : ''); setCacheReadPrice(model.cacheReadPricePerM ? String(model.cacheReadPricePerM) : ''); setCacheWritePrice(model.cacheWritePricePerM ? String(model.cacheWritePricePerM) : ''); }}><X size={16} /></button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`model-row ${isDefault ? 'is-default' : ''}`}>
      <code className="model-row-name">{model.id}</code>
      {model.contextWindow ? <span className="model-row-badge">{formatContext(model.contextWindow)}</span> : <span />}
      {hasPrice && (
        <span className="model-row-badge model-price-badge">
          {model.inputPricePerM ? `$in ${model.inputPricePerM}` : ''}
          {model.outputPricePerM ? ` · $out ${model.outputPricePerM}` : ''}
          {model.cacheReadPricePerM ? ` · $cr ${model.cacheReadPricePerM}` : ''}
          {model.cacheWritePricePerM ? ` · $cw ${model.cacheWritePricePerM}` : ''}
        </span>
      )}
      <button
        className={`settings-icon-btn ${isDefault ? 'active' : ''}`}
        aria-label="设为默认"
        title={isDefault ? '默认模型' : '设为默认'}
        onClick={onSetDefault}
      >
        <Check size={15} />
      </button>
      <button className="settings-icon-btn" aria-label="编辑" onClick={() => setEditing(true)}><Pencil size={15} /></button>
      <button className="settings-icon-btn" aria-label="删除" onClick={onDelete}><Trash2 size={15} /></button>
    </div>
  );
}

function AddModelButton({ onAdd }: { onAdd: (model: CustomModel) => void }) {
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState('');
  const [ctx, setCtx] = useState('');
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [cacheReadPrice, setCacheReadPrice] = useState('');
  const [cacheWritePrice, setCacheWritePrice] = useState('');

  function commit() {
    if (!id.trim()) return;
    onAdd({
      id: id.trim(),
      contextWindow: ctx.trim() ? Number(ctx) : undefined,
      inputPricePerM: inputPrice.trim() ? Number(inputPrice) : undefined,
      outputPricePerM: outputPrice.trim() ? Number(outputPrice) : undefined,
      cacheReadPricePerM: cacheReadPrice.trim() ? Number(cacheReadPrice) : undefined,
      cacheWritePricePerM: cacheWritePrice.trim() ? Number(cacheWritePrice) : undefined,
    });
    setId('');
    setCtx('');
    setInputPrice('');
    setOutputPrice('');
    setCacheReadPrice('');
    setCacheWritePrice('');
    setAdding(false);
  }

  if (!adding) {
    return (
      <button className="settings-action-btn model-add-btn" onClick={() => setAdding(true)}>
        <Plus size={14} /><span>添加模型</span>
      </button>
    );
  }

  return (
    <div className="model-row editing model-row-priced">
      <div className="model-edit-wrapper">
        <div className="model-edit-grid-simple">
          <input className="settings-text-field" autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="模型 ID (如 gpt-4o)" onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
          <input className="settings-text-field" value={ctx} onChange={(e) => setCtx(e.target.value)} placeholder="上下文 (如 128000)" onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
          <input className="settings-text-field" value={inputPrice} onChange={(e) => setInputPrice(e.target.value)} placeholder="输入 $/1M" type="number" min="0" step="0.01" onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
          <input className="settings-text-field" value={outputPrice} onChange={(e) => setOutputPrice(e.target.value)} placeholder="输出 $/1M" type="number" min="0" step="0.01" onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
          <input className="settings-text-field" value={cacheReadPrice} onChange={(e) => setCacheReadPrice(e.target.value)} placeholder="缓存读 $/1M" type="number" min="0" step="0.01" onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
          <input className="settings-text-field" value={cacheWritePrice} onChange={(e) => setCacheWritePrice(e.target.value)} placeholder="缓存写 $/1M" type="number" min="0" step="0.01" onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
        </div>
        <div className="model-edit-actions">
          <button className="settings-icon-btn" aria-label="确认" onClick={commit}><Check size={16} /></button>
          <button className="settings-icon-btn" aria-label="取消" onClick={() => { setAdding(false); setId(''); setCtx(''); setInputPrice(''); setOutputPrice(''); setCacheReadPrice(''); setCacheWritePrice(''); }}><X size={16} /></button>
        </div>
      </div>
    </div>
  );
}

function formatContext(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
