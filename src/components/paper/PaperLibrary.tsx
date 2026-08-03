import { Button, Input, List, Select, Tag, Tooltip, Typography } from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { Paper, PaperStatus } from '../../types/paperApp';

const { Text } = Typography;

const statusOptions: PaperStatus[] = ['未读', '粗读', '精读', '已摘录', '待复核'];

export type PaperLibraryProps = {
  papers: Paper[];
  filteredPapers: Paper[];
  selectedId: string | null;
  query: string;
  statusFilter: string;
  tagFilter: string;
  allTags: string[];
  collapsed: boolean;
  onQueryChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onTagFilterChange: (value: string) => void;
  onSelect: (id: string) => void;
  onToggleCollapse: () => void;
};

export function PaperLibrary({
  papers,
  filteredPapers,
  selectedId,
  query,
  statusFilter,
  tagFilter,
  allTags,
  collapsed,
  onQueryChange,
  onStatusFilterChange,
  onTagFilterChange,
  onSelect,
  onToggleCollapse,
}: PaperLibraryProps) {
  if (collapsed) {
    return (
      <aside className="paper-library paper-library-collapsed">
        <Tooltip title="展开论文库" placement="right">
          <Button
            type="text"
            icon={<MenuUnfoldOutlined />}
            onClick={onToggleCollapse}
            aria-label="展开论文库"
          />
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside className="paper-library">
      <div className="panel-heading">
        <Text strong>论文库</Text>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="panel-count">
            {filteredPapers.length}/{papers.length}
          </span>
          <Tooltip title="折叠论文库">
            <Button
              type="text"
              size="small"
              icon={<MenuFoldOutlined />}
              onClick={onToggleCollapse}
              aria-label="折叠论文库"
            />
          </Tooltip>
        </div>
      </div>

      <Input
        className="library-search"
        allowClear
        prefix={<SearchOutlined />}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索论文"
      />

      <div className="filter-row">
        <Select
          size="small"
          value={statusFilter}
          onChange={onStatusFilterChange}
          options={['全部', ...statusOptions].map((value) => ({
            value,
            label: value === '全部' ? '状态' : value,
          }))}
        />
        <Select
          size="small"
          value={tagFilter}
          onChange={onTagFilterChange}
          options={allTags.map((tag) => ({
            value: tag,
            label: tag === '全部' ? '标签' : tag,
          }))}
        />
      </div>

      <List
        className="paper-list"
        dataSource={filteredPapers}
        locale={{ emptyText: '没有匹配的论文' }}
        renderItem={(paper) => (
          <List.Item
            className={paper.id === selectedId ? 'paper-row active' : 'paper-row'}
            onClick={() => onSelect(paper.id)}
          >
            <div className="paper-row-main">
              <Text className="paper-row-title" ellipsis>
                {paper.title || '未命名论文'}
              </Text>
              <Text className="paper-row-meta" ellipsis>
                {paper.authors || '作者待补'} · {paper.year || '年份待补'}
              </Text>
              <div className="paper-row-tags">
                <span className="status-pill">{paper.status}</span>
                {paper.tags.slice(0, 2).map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </div>
            </div>
          </List.Item>
        )}
      />
    </aside>
  );
}
