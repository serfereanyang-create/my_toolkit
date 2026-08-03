import { Button, Empty, Space, Spin, Typography } from 'antd';
import { FileAddOutlined, ImportOutlined, UserOutlined } from '@ant-design/icons';
import type { SessionStatus } from '../../lib/uiState';

const { Paragraph } = Typography;

export type EmptyWorkspaceProps = {
  sessionStatus: SessionStatus;
  onLogin: () => void;
  onCreatePaper: () => void;
  onImportLibrary: () => void;
};

export function emptyWorkspaceCopy(status: SessionStatus) {
  if (status === 'loading') return '正在恢复本地账户…';
  if (status === 'anonymous') return '登录本机账户以访问论文库';
  return '当前账户还没有论文卡片';
}

export function EmptyWorkspace({
  sessionStatus,
  onLogin,
  onCreatePaper,
  onImportLibrary,
}: EmptyWorkspaceProps) {
  if (sessionStatus === 'loading') {
    return (
      <div className="empty-workspace">
        <Space direction="vertical" align="center" size={16}>
          <Spin size="large" />
          <Paragraph className="quiet-note" style={{ margin: 0 }}>
            {emptyWorkspaceCopy('loading')}
          </Paragraph>
        </Space>
      </div>
    );
  }

  const description = emptyWorkspaceCopy(sessionStatus);

  return (
    <Empty className="empty-workspace" description={description}>
      <Space wrap>
        {sessionStatus === 'anonymous' ? (
          <Button type="primary" icon={<UserOutlined />} onClick={onLogin}>
            登录 / 注册
          </Button>
        ) : (
          <>
            <Button type="primary" icon={<FileAddOutlined />} onClick={onCreatePaper}>
              新建论文卡片
            </Button>
            <Button icon={<ImportOutlined />} onClick={onImportLibrary}>
              导入资料库
            </Button>
          </>
        )}
      </Space>
    </Empty>
  );
}
