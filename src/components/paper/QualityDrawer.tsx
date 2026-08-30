import {
  Button,
  Checkbox,
  Divider,
  Drawer,
  Progress,
  Tooltip,
  Typography,
} from 'antd';
import { DownloadOutlined, FileTextOutlined } from '@ant-design/icons';
import type { Paper } from '../../types/paperApp';

const { Paragraph } = Typography;

export const DEFAULT_CHECKLIST_ITEMS = [
  '研究问题明确',
  '方法可复现',
  '样本/数据说明完整',
  '统计或评估指标清楚',
  '图表来源可追踪',
  '局限性已记录',
  '引用字段完整',
] as const;

export type QualityDrawerProps = {
  open: boolean;
  onClose: () => void;
  selected: Paper | null;
  issues: string[];
  paperCount: number;
  evidenceCount: number;
  issueCount: number;
  checklistItems?: readonly string[];
  onChecklistChange: (item: string, checked: boolean) => void;
  onImportReferences: () => void;
  onExportMarkdown: () => void;
  onExportLibrary: () => void;
  onOpenReview: () => void;
  onExportMatrix: () => void;
};

export function QualityDrawer({
  open,
  onClose,
  selected,
  issues,
  paperCount,
  evidenceCount,
  issueCount,
  checklistItems = DEFAULT_CHECKLIST_ITEMS,
  onChecklistChange,
  onImportReferences,
  onExportMarkdown,
  onExportLibrary,
  onOpenReview,
  onExportMatrix,
}: QualityDrawerProps) {
  const completedChecks = selected
    ? checklistItems.filter((item) => Boolean(selected.checklist[item])).length
    : 0;
  const paperTitle = selected?.title || '未命名论文';

  return (
    <Drawer
      title="质量检查"
      placement="right"
      width={400}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
      className="drawer-shell"
    >
      <div className="quality-panel" style={{ borderLeft: 0, height: 'auto', overflow: 'visible' }}>
        <div className="inspector-block">
          <div className="inspector-title">质量检查</div>
          <div className="issue-list">
            {!selected || issues.length === 0 ? (
              <div className="issue-item ok">引用字段完整</div>
            ) : (
              issues.map((issue) => (
                <div key={issue} className="issue-item">
                  {issue.replace(`${paperTitle}: `, '')}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="inspector-block">
          <div className="inspector-title">材料自查</div>
          <Progress
            percent={Math.round((completedChecks / checklistItems.length) * 100)}
            size="small"
            showInfo={false}
          />
          <Divider />
          <div className="checklist-list">
            {checklistItems.map((item) => (
              <Checkbox
                key={item}
                checked={Boolean(selected?.checklist[item])}
                disabled={!selected}
                onChange={(event) => onChecklistChange(item, event.target.checked)}
              >
                {item}
              </Checkbox>
            ))}
          </div>
        </div>

        <div className="inspector-block">
          <div className="inspector-title">工作台</div>
          <div className="stats-inline">
            <div className="stat-chip">
              <strong>{paperCount}</strong>
              <span>论文</span>
            </div>
            <div className="stat-chip">
              <strong>{evidenceCount}</strong>
              <span>证据</span>
            </div>
            <div className="stat-chip">
              <strong>{issueCount}</strong>
              <span>待修</span>
            </div>
          </div>
        </div>

        <div className="inspector-block">
          <div className="inspector-title">导入 / 导出</div>
          <Paragraph className="quiet-note">
            支持 BibTeX、RIS、PubMed NBIB、CNKI 文本和 CSV/TSV。
          </Paragraph>
          <div className="inspector-actions">
            <Button block type="primary" onClick={onImportReferences}>
              导入文献
            </Button>
            <Button block icon={<FileTextOutlined />} onClick={onOpenReview}>
              生成综述
            </Button>
            <Tooltip title="保存为 Markdown 文件">
              <Button block icon={<DownloadOutlined />} onClick={onExportMarkdown}>
                导出 Markdown
              </Button>
            </Tooltip>
            <Button block icon={<DownloadOutlined />} onClick={onExportMatrix}>
              导出文献矩阵
            </Button>
            <Button block onClick={onExportLibrary}>
              导出资料库
            </Button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
