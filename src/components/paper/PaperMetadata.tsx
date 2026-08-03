import { Input, Select } from 'antd';
import type { Paper, PaperStatus } from '../../types/paperApp';

const statusOptions: PaperStatus[] = ['未读', '粗读', '精读', '已摘录', '待复核'];

export type PaperMetadataProps = {
  paper: Paper;
  onChange: (patch: Partial<Paper>) => void;
};

function splitTags(value: string) {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function PaperMetadata({ paper, onChange }: PaperMetadataProps) {
  return (
    <>
      <Input.TextArea
        className="document-title-input"
        value={paper.title}
        onChange={(event) => onChange({ title: event.target.value })}
        placeholder="无标题论文"
        autoSize={{ minRows: 1, maxRows: 3 }}
      />

      <div className="property-board">
        <div className="property-label">作者</div>
        <div className="property-value">
          <Input
            value={paper.authors}
            onChange={(event) => onChange({ authors: event.target.value })}
            placeholder="添加作者"
          />
        </div>

        <div className="property-label">年份</div>
        <div className="property-value">
          <Input
            value={paper.year}
            onChange={(event) => onChange({ year: event.target.value })}
            placeholder="2024"
          />
        </div>

        <div className="property-label">状态</div>
        <div className="property-value">
          <Select
            value={paper.status}
            onChange={(status) => onChange({ status })}
            options={statusOptions.map((status) => ({ value: status, label: status }))}
            style={{ width: '100%' }}
          />
        </div>

        <div className="property-label">来源</div>
        <div className="property-value">
          <Input
            value={paper.source}
            onChange={(event) => onChange({ source: event.target.value })}
            placeholder="期刊 / 会议 / 预印本"
          />
        </div>

        <div className="property-label">DOI</div>
        <div className="property-value">
          <Input
            value={paper.doi}
            onChange={(event) => onChange({ doi: event.target.value })}
            placeholder="10.xxxx/..."
          />
        </div>

        <div className="property-label">URL</div>
        <div className="property-value">
          <Input
            value={paper.url}
            onChange={(event) => onChange({ url: event.target.value })}
            placeholder="https://"
          />
        </div>

        <div className="property-label">标签</div>
        <div className="property-value">
          <Input
            value={paper.tags.join(', ')}
            onChange={(event) => onChange({ tags: splitTags(event.target.value) })}
            placeholder="逗号分隔"
          />
        </div>
      </div>
    </>
  );
}
