import { Input } from 'antd';
import type { EditorSection, Paper } from '../../types/paperApp';

const { TextArea } = Input;

export type ReadingNotesProps = {
  paper: Paper;
  section: Exclude<EditorSection, 'evidence'>;
  onChange: (patch: Partial<Paper>) => void;
};

export function ReadingNotes({ paper, section, onChange }: ReadingNotesProps) {
  if (section === 'overview') {
    return (
      <>
        <section className="document-section">
          <div className="section-label">研究问题</div>
          <div className="section-block">
            <TextArea
              className="note-area"
              autoSize={{ minRows: 3, maxRows: 10 }}
              value={paper.question}
              onChange={(event) => onChange({ question: event.target.value })}
              placeholder="这篇论文要回答什么问题？"
            />
          </div>
        </section>
        <section className="document-section">
          <div className="section-label">方法</div>
          <div className="section-block">
            <TextArea
              className="note-area"
              autoSize={{ minRows: 3, maxRows: 10 }}
              value={paper.method}
              onChange={(event) => onChange({ method: event.target.value })}
              placeholder="记录方法、流程或实验设计"
            />
          </div>
        </section>
        <section className="document-section">
          <div className="section-label">数据集 / 样本</div>
          <div className="section-block">
            <TextArea
              className="note-area"
              autoSize={{ minRows: 3, maxRows: 10 }}
              value={paper.dataset}
              onChange={(event) => onChange({ dataset: event.target.value })}
              placeholder="样本、数据来源、规模"
            />
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <section className="document-section">
        <div className="section-label">关键发现</div>
        <div className="section-block">
          <TextArea
            className="note-area"
            autoSize={{ minRows: 4, maxRows: 12 }}
            value={paper.findings}
            onChange={(event) => onChange({ findings: event.target.value })}
            placeholder="写下最重要的结论与发现"
          />
        </div>
      </section>
      <section className="document-section">
        <div className="section-label">局限性</div>
        <div className="section-block">
          <TextArea
            className="note-area"
            autoSize={{ minRows: 4, maxRows: 12 }}
            value={paper.limitations}
            onChange={(event) => onChange({ limitations: event.target.value })}
            placeholder="样本、方法、外部效度等方面的限制"
          />
        </div>
      </section>
      <section className="document-section">
        <div className="section-label">可信度备注</div>
        <div className="section-block">
          <TextArea
            className="note-area"
            autoSize={{ minRows: 4, maxRows: 12 }}
            value={paper.credibility}
            onChange={(event) => onChange({ credibility: event.target.value })}
            placeholder="你对结论可信度的判断"
          />
        </div>
      </section>
    </>
  );
}
