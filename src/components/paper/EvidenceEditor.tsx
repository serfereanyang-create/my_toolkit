import { Button, Empty, Input, Select, Tag } from 'antd';
import type { Evidence, Reliability } from '../../types/paperApp';

const { TextArea } = Input;

const reliabilityOptions: Reliability[] = ['高', '中', '低'];
const reliabilityColor: Record<Reliability, string> = {
  高: 'success',
  中: 'warning',
  低: 'error',
};

export type EvidenceEditorProps = {
  evidence: Evidence[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<Evidence>) => void;
  onRemove: (id: string) => void;
};

function splitTags(value: string) {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function EvidenceEditor({
  evidence,
  onAdd,
  onUpdate,
  onRemove,
}: EvidenceEditorProps) {
  return (
    <section className="document-section">
      <div className="evidence-toolbar">
        <div className="section-label" style={{ margin: 0 }}>
          证据表
        </div>
        <Button type="primary" size="small" onClick={onAdd}>
          添加证据
        </Button>
      </div>

      {evidence.length === 0 ? (
        <Empty description="还没有证据条目。把论文里的关键主张拆成可追踪证据。" />
      ) : (
        <div className="evidence-stack">
          {evidence.map((item) => (
            <div key={item.id} className="evidence-item">
              <div className="evidence-item-head">
                <Input
                  value={item.claim}
                  onChange={(event) => onUpdate(item.id, { claim: event.target.value })}
                  placeholder="主张"
                />
                <Tag color={reliabilityColor[item.reliability]}>{item.reliability}</Tag>
                <Button danger type="text" onClick={() => onRemove(item.id)}>
                  移除
                </Button>
              </div>
              <TextArea
                rows={3}
                value={item.support}
                onChange={(event) => onUpdate(item.id, { support: event.target.value })}
                placeholder="证据内容"
              />
              <div className="evidence-meta">
                <Input
                  value={item.locator}
                  onChange={(event) => onUpdate(item.id, { locator: event.target.value })}
                  placeholder="页码 / 段落"
                />
                <Select
                  value={item.reliability}
                  onChange={(reliability) => onUpdate(item.id, { reliability })}
                  options={reliabilityOptions.map((value) => ({ value, label: value }))}
                />
                <Input
                  value={item.tags.join(', ')}
                  onChange={(event) => onUpdate(item.id, { tags: splitTags(event.target.value) })}
                  placeholder="标签"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
