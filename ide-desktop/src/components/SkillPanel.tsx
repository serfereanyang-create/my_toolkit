import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, ChevronDown, ChevronRight, RefreshCw, Sparkles } from 'lucide-react';
import { desktop } from '../lib/ipc';
import { useQualityRevision } from '../lib/qualityRevision';

/*
 * SkillPanel — 工作区技能（.aicode/skills/<name>/SKILL.md）浏览面板。
 * 通过质量网关只读调用 CLI 的 skill_list，不直接触碰文件系统。
 */

interface SkillListItem {
  name: string;
  description: string;
  triggers: string[];
  instructions: string;
  sourcePath?: string;
}

interface SkillErrorItem {
  path: string;
  reason: string;
}

interface SkillListData {
  skills?: SkillListItem[];
  errors?: SkillErrorItem[];
}

export function SkillPanel() {
  const { current } = useQualityRevision(true);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [loadErrors, setLoadErrors] = useState<SkillErrorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await desktop.quality.invoke('skill_list', {}, current?.label);
      if (!result.ok) {
        setError(result.error ?? '技能扫描失败');
        return;
      }
      const data = (result.data ?? {}) as SkillListData;
      setSkills(Array.isArray(data.skills) ? data.skills : []);
      setLoadErrors(Array.isArray(data.errors) ? data.errors : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="skill-panel" aria-label="工作区技能">
      <header className="skill-panel-head">
        <span className="skill-panel-icon"><Sparkles size={16} /></span>
        <div className="skill-panel-titles">
          <strong>技能（Skills）</strong>
          <span>位于 <code>.aicode/skills/…/SKILL.md</code>，任务命中触发词时自动注入指令</span>
        </div>
        <button type="button" className="skill-panel-refresh" onClick={() => void refresh()} disabled={loading} title="重新扫描">
          <RefreshCw size={14} className={loading ? 'skill-panel-spin' : undefined} />
        </button>
      </header>

      {error && (
        <div className="skill-panel-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {!error && !loading && skills.length === 0 && (
        <div className="skill-panel-empty">
          <BookOpen size={22} />
          <p>当前工作区还没有技能。</p>
          <p className="skill-panel-empty-hint">
            新建 <code>.aicode/skills/&lt;名称&gt;/SKILL.md</code>，frontmatter 写 name / description / triggers，
            正文写给智能体的操作指令。触发词命中的任务会自动注入该指令。
          </p>
        </div>
      )}

      <ul className="skill-panel-list">
        {skills.map((skill) => {
          const open = expanded === skill.name;
          return (
            <li key={skill.name} className={`skill-panel-item ${open ? 'open' : ''}`}>
              <button
                type="button"
                className="skill-panel-item-head"
                onClick={() => setExpanded(open ? null : skill.name)}
                aria-expanded={open}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="skill-panel-item-name">{skill.name}</span>
                {skill.triggers.length > 0 && (
                  <span className="skill-panel-item-triggers">{skill.triggers.slice(0, 3).join('、')}</span>
                )}
              </button>
              {skill.description && <p className="skill-panel-item-desc">{skill.description}</p>}
              {open && (
                <pre className="skill-panel-item-body" aria-label={`${skill.name} 指令内容`}>{skill.instructions}</pre>
              )}
            </li>
          );
        })}
      </ul>

      {loadErrors.length > 0 && (
        <div className="skill-panel-broken">
          <strong>加载失败（{loadErrors.length}）</strong>
          {loadErrors.map((e) => (
            <div key={e.path} className="skill-panel-broken-row">
              <code>{e.path}</code>
              <span>{e.reason}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
