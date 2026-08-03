import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Dropdown,
  Input,
  Popover,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  CheckCircleOutlined,
  EllipsisOutlined,
  FileAddOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { SaveStatus } from '../../lib/uiState';

const { Title, Text } = Typography;

export type AppHeaderProps = {
  currentTitle?: string;
  issueCount: number;
  saveStatus: SaveStatus;
  query: string;
  accountInitial?: string;
  accountOpen?: boolean;
  settingsOpen?: boolean;
  onQueryChange: (value: string) => void;
  onOpenQuality: () => void;
  onOpenAccount: () => void;
  onRetrySave: () => void;
  onCreatePaper?: () => void;
  onImportReferences?: () => void;
  moreMenuItems: MenuProps['items'];
  displaySettings: ReactNode;
  onSettingsOpenChange?: (open: boolean) => void;
};

function saveStatusLabel(status: SaveStatus) {
  if (status === 'saving') return '保存中…';
  if (status === 'saved') return '已保存';
  if (status === 'failed') return '保存失败';
  return '';
}

export function AppHeader({
  currentTitle,
  issueCount,
  saveStatus,
  query,
  accountInitial,
  accountOpen = false,
  settingsOpen = false,
  onQueryChange,
  onOpenQuality,
  onOpenAccount,
  onRetrySave,
  onCreatePaper,
  onImportReferences,
  moreMenuItems,
  displaySettings,
  onSettingsOpenChange,
}: AppHeaderProps) {
  const saveLabel = saveStatusLabel(saveStatus);

  return (
    <header className="command-bar">
      <div className="product-title">
        <div className="product-mark">P</div>
        <div>
          <Title level={4}>科研论文辅助工作台</Title>
          <Text type="secondary" className="product-sub">
            {currentTitle?.trim() || '本地文献阅读 · 证据管理 · 引用自查'}
          </Text>
        </div>
      </div>

      <div className="command-actions">
        <Space size={8} wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索论文"
            style={{ width: 180 }}
          />

          {saveLabel ? (
            <Space size={4}>
              <Text type={saveStatus === 'failed' ? 'danger' : 'secondary'}>{saveLabel}</Text>
              {saveStatus === 'failed' ? (
                <Button size="small" type="link" icon={<ReloadOutlined />} onClick={onRetrySave}>
                  重试
                </Button>
              ) : null}
            </Space>
          ) : null}

          {onCreatePaper ? (
            <Button type="primary" icon={<FileAddOutlined />} onClick={onCreatePaper}>
              新建
            </Button>
          ) : null}
          {onImportReferences ? (
            <Button onClick={onImportReferences}>导入</Button>
          ) : null}

          <Tooltip title="质量检查">
            <Badge count={issueCount} size="small" offset={[-2, 2]}>
              <Button
                icon={<CheckCircleOutlined />}
                onClick={onOpenQuality}
                aria-label="质量检查"
              />
            </Badge>
          </Tooltip>

          <Popover
            trigger="click"
            placement="bottomRight"
            open={settingsOpen}
            onOpenChange={onSettingsOpenChange}
            arrow={false}
            overlayClassName="settings-popover"
            content={displaySettings}
          >
            <Tooltip title="显示设置">
              <Button
                className={settingsOpen ? 'settings-trigger active' : 'settings-trigger'}
                icon={<SettingOutlined />}
                aria-label="显示设置"
              />
            </Tooltip>
          </Popover>

          <Tooltip title="账户设置">
            <Button
              className={accountOpen ? 'account-trigger active' : 'account-trigger'}
              icon={accountInitial ? undefined : <UserOutlined />}
              aria-label="账户设置"
              onClick={onOpenAccount}
            >
              {accountInitial || null}
            </Button>
          </Tooltip>

          <Dropdown menu={{ items: moreMenuItems }} placement="bottomRight">
            <Button icon={<EllipsisOutlined />}>更多</Button>
          </Dropdown>
        </Space>
      </div>
    </header>
  );
}
