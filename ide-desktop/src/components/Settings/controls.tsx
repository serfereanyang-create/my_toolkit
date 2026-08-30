import type { ReactNode } from 'react';

/* Rounded pill toggle. Blue when on, matching the Codex reference. */
export function Toggle({ checked, onChange, label }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

/* Two-or-more option segmented control (e.g. 底部 · 右侧). */
export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          className={`segmented-item ${value === opt.value ? 'active' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* Pill-shaped select. Renders a native <select> styled as a rounded control. */
export function SelectPill<T extends string>({ value, options, onChange, icon }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  icon?: ReactNode;
}) {
  return (
    <div className="select-pill">
      {icon && <span className="select-pill-icon">{icon}</span>}
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

/* A grouped card with an optional section heading above it. */
export function SettingsCard({ heading, children }: {
  heading?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-group">
      {heading && <h3 className="settings-group-heading">{heading}</h3>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

/* A single row inside a card: title + optional description on the left,
   an interactive control on the right. */
export function SettingRow({ title, description, control }: {
  title: string;
  description?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <span className="setting-row-title">{title}</span>
        {description && <span className="setting-row-desc">{description}</span>}
      </div>
      <div className="setting-row-control">{control}</div>
    </div>
  );
}

/* A color swatch pill: filled chip showing the current value, with the hex
   label inside. Clicking opens the native color picker. */
export function ColorSwatch({ value, onChange }: {
  value: string;
  onChange: (next: string) => void;
}) {
  // Pick a readable label color based on the swatch brightness.
  const hex = value.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  const light = (r * 299 + g * 587 + b * 114) / 1000 > 150;
  return (
    <label className="color-swatch" style={{ background: value, color: light ? '#1a1c1f' : '#ffffff' }}>
      <span className="color-swatch-dot" style={{ borderColor: light ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.5)' }} />
      <span className="color-swatch-value">{value.toUpperCase()}</span>
      <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/* A horizontal slider with a numeric readout on the right. */
export function Slider({ value, min, max, onChange }: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="slider-control">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="slider-value">{value}</span>
    </div>
  );
}

/* A small number input with a trailing unit suffix (e.g. px). */
export function NumberField({ value, onChange, suffix, min, max }: {
  value: number;
  onChange: (next: number) => void;
  suffix?: string;
  min?: number;
  max?: number;
}) {
  return (
    <div className="number-field">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {suffix && <span className="number-field-suffix">{suffix}</span>}
    </div>
  );
}

/* A text input styled to match the settings surface. */
export function TextField({ value, onChange, placeholder }: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="settings-text-field"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/* A multi-line text area styled to match the settings surface. */
export function TextArea({ value, onChange, placeholder, rows = 5 }: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      className="settings-textarea"
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/* A free-standing section header (title + optional description) with an
   optional action node on the right — a "了解更多" link, a refresh icon, a
   "保存" button, etc. Used for the loose groups outside a card. */
export function SectionHeader({ title, description, action }: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="settings-section-header">
      <div className="settings-section-header-text">
        <h3 className="settings-section-title">{title}</h3>
        {description && <p className="settings-section-desc">{description}</p>}
      </div>
      {action && <div className="settings-section-action">{action}</div>}
    </div>
  );
}

/* A bordered empty-state / info panel — the dashed or solid box that shows
   "未找到钩子", "尚无工作树", "正在加载..." etc. Optional icon + spinner. */
export function EmptyState({ title, description, icon, loading }: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="settings-empty">
      {loading && <span className="settings-spinner" aria-hidden />}
      {!loading && icon && <span className="settings-empty-icon">{icon}</span>}
      <div className="settings-empty-text">
        <span className="settings-empty-title">{title}</span>
        {description && <span className="settings-empty-desc">{description}</span>}
      </div>
    </div>
  );
}
