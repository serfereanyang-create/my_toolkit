import {
  Button,
  Divider,
  Drawer,
  Input,
  Segmented,
  Typography,
} from 'antd';
import type { AccountProfile, AuthUser } from '../../types/paperApp';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

export type AuthMode = 'login' | 'register';

export type LoginForm = {
  account: string;
  password: string;
};

export type RegisterForm = {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
};

export type PasswordForm = {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export type AccountDrawerProps = {
  open: boolean;
  onClose: () => void;
  currentUser: AuthUser | null;
  authMode: AuthMode;
  authBusy: boolean;
  authError: string;
  loginForm: LoginForm;
  registerForm: RegisterForm;
  accountDraft: AccountProfile;
  passwordForm: PasswordForm;
  onAuthModeChange: (mode: AuthMode) => void;
  onLoginFormChange: (patch: Partial<LoginForm>) => void;
  onRegisterFormChange: (patch: Partial<RegisterForm>) => void;
  onAccountDraftChange: <K extends keyof AccountProfile>(key: K, value: AccountProfile[K]) => void;
  onPasswordFormChange: (patch: Partial<PasswordForm>) => void;
  onLogin: () => void;
  onRegister: () => void;
  onSaveProfile: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
};

export function AccountDrawer({
  open,
  onClose,
  currentUser,
  authMode,
  authBusy,
  authError,
  loginForm,
  registerForm,
  accountDraft,
  passwordForm,
  onAuthModeChange,
  onLoginFormChange,
  onRegisterFormChange,
  onAccountDraftChange,
  onPasswordFormChange,
  onLogin,
  onRegister,
  onSaveProfile,
  onChangePassword,
  onLogout,
}: AccountDrawerProps) {
  const accountInitial = (
    currentUser?.displayName ||
    currentUser?.username ||
    '?'
  )
    .trim()
    .charAt(0)
    .toUpperCase() || '?';

  return (
    <Drawer
      title={currentUser ? '账户设置' : '本机账户'}
      placement="right"
      width={400}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
      className="drawer-shell"
    >
      {currentUser ? (
        <div className="settings-panel account-panel" style={{ width: '100%' }}>
          <div className="account-header">
            <div className="account-avatar">{accountInitial}</div>
            <div className="account-header-text">
              <div className="settings-panel-title">
                {currentUser.displayName || currentUser.username}
              </div>
              <div className="account-subtitle">@{currentUser.username} · 本机账户</div>
            </div>
          </div>

          <div className="settings-row">
            <span className="pref-label">显示名</span>
            <Input
              value={accountDraft.displayName}
              onChange={(event) => onAccountDraftChange('displayName', event.target.value)}
              placeholder="例如：林启"
            />
          </div>
          <div className="settings-row">
            <span className="pref-label">机构 / 实验室</span>
            <Input
              value={accountDraft.institution}
              onChange={(event) => onAccountDraftChange('institution', event.target.value)}
              placeholder="学校、研究所或课题组"
            />
          </div>
          <div className="settings-row">
            <span className="pref-label">研究方向</span>
            <Input
              value={accountDraft.researchField}
              onChange={(event) => onAccountDraftChange('researchField', event.target.value)}
              placeholder="如：方法学 / NLP / 材料科学"
            />
          </div>
          <div className="settings-row">
            <span className="pref-label">邮箱</span>
            <Input
              value={accountDraft.email}
              onChange={(event) => onAccountDraftChange('email', event.target.value)}
              placeholder="用于登录，可留空"
            />
          </div>
          <div className="settings-row">
            <span className="pref-label">备注</span>
            <TextArea
              rows={3}
              value={accountDraft.notes}
              onChange={(event) => onAccountDraftChange('notes', event.target.value)}
              placeholder="签名、单位或导出备注"
            />
          </div>

          <Button type="primary" block onClick={onSaveProfile}>
            保存资料
          </Button>

          <Divider className="account-divider" />
          <div className="settings-panel-title">修改密码</div>
          <Input.Password
            value={passwordForm.oldPassword}
            onChange={(event) => onPasswordFormChange({ oldPassword: event.target.value })}
            placeholder="旧密码"
          />
          <Input.Password
            value={passwordForm.newPassword}
            onChange={(event) => onPasswordFormChange({ newPassword: event.target.value })}
            placeholder="新密码（至少 8 位）"
          />
          <Input.Password
            value={passwordForm.confirmPassword}
            onChange={(event) => onPasswordFormChange({ confirmPassword: event.target.value })}
            placeholder="确认新密码"
          />
          <Button block loading={authBusy} onClick={onChangePassword}>
            修改密码
          </Button>

          <Paragraph className="quiet-note account-note">
            论文库已按账户隔离；账户间迁移请使用导出 / 导入资料库。
          </Paragraph>
          <Button danger block onClick={onLogout}>
            退出登录
          </Button>
        </div>
      ) : (
        <div className="settings-panel account-panel auth-panel" style={{ width: '100%' }}>
          <div className="settings-panel-title">本机账户</div>
          <Segmented
            block
            value={authMode}
            onChange={(value) => onAuthModeChange(value as AuthMode)}
            options={[
              { label: '登录', value: 'login' },
              { label: '注册', value: 'register' },
            ]}
          />

          {authMode === 'login' ? (
            <>
              <Input
                value={loginForm.account}
                onChange={(event) => onLoginFormChange({ account: event.target.value })}
                placeholder="用户名或邮箱"
              />
              <Input.Password
                value={loginForm.password}
                onChange={(event) => onLoginFormChange({ password: event.target.value })}
                onPressEnter={onLogin}
                placeholder="密码"
              />
              <Button type="primary" block loading={authBusy} onClick={onLogin}>
                登录
              </Button>
            </>
          ) : (
            <>
              <Input
                value={registerForm.username}
                onChange={(event) => onRegisterFormChange({ username: event.target.value })}
                placeholder="用户名（3–32 位）"
              />
              <Input
                value={registerForm.email}
                onChange={(event) => onRegisterFormChange({ email: event.target.value })}
                placeholder="邮箱（可选）"
              />
              <Input.Password
                value={registerForm.password}
                onChange={(event) => onRegisterFormChange({ password: event.target.value })}
                placeholder="密码（至少 8 位）"
              />
              <Input.Password
                value={registerForm.confirmPassword}
                onChange={(event) => onRegisterFormChange({ confirmPassword: event.target.value })}
                onPressEnter={onRegister}
                placeholder="确认密码"
              />
              <Button type="primary" block loading={authBusy} onClick={onRegister}>
                注册并登录
              </Button>
            </>
          )}

          {authError ? (
            <Text type="danger" className="auth-error">
              {authError}
            </Text>
          ) : null}

          <Paragraph className="quiet-note account-note">
            账户与论文库只保存在此设备，不会上传云端。
          </Paragraph>
        </div>
      )}
    </Drawer>
  );
}
