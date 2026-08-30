import { useEffect, useState } from 'react';
import { Alert, Button, Input, InputNumber, Space, Typography, message } from 'antd';
import { resolveAiReviewApi } from '../../lib/reviewDigest';

const { Paragraph } = Typography;

const DEFAULT_TEMPERATURE = 0.4;

export type AiConfigPublic = {
  baseUrl: string;
  model: string;
  temperature: number;
  hasKey: boolean;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function AiSettings() {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState<number>(DEFAULT_TEMPERATURE);
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [saveError, setSaveError] = useState('');
  const [desktopAvailable, setDesktopAvailable] = useState(true);

  const applyConfig = (config: AiConfigPublic | null | undefined) => {
    setBaseUrl(typeof config?.baseUrl === 'string' ? config.baseUrl : '');
    setModel(typeof config?.model === 'string' ? config.model : '');
    setTemperature(typeof config?.temperature === 'number' ? config.temperature : DEFAULT_TEMPERATURE);
    setHasKey(Boolean(config?.hasKey));
  };

  // 挂载时读取已保存配置；抛错（如非桌面端）→ 仅桌面端可用提示
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const api = resolveAiReviewApi();
      if (!api) {
        if (!cancelled) setDesktopAvailable(false);
        return;
      }
      try {
        const config = await api.getConfig();
        if (!cancelled) applyConfig(config);
      } catch {
        if (!cancelled) setDesktopAvailable(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    const api = resolveAiReviewApi();
    if (!api) {
      setDesktopAvailable(false);
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const result = await api.saveConfig({
        baseUrl,
        model,
        temperature,
        apiKey: keyInput || undefined,
      });
      if (result?.ok) {
        message.success('AI 配置已保存');
        setKeyInput('');
        try {
          applyConfig(await api.getConfig());
        } catch {
          setDesktopAvailable(false);
        }
      } else {
        setSaveError(result?.error || '保存失败，请检查填写内容');
      }
    } catch (error) {
      setSaveError(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    const api = resolveAiReviewApi();
    if (!api) {
      setDesktopAvailable(false);
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const result = await api.saveConfig({ baseUrl, model, temperature, apiKey: '' });
      if (result?.ok) {
        message.success('已清除保存的 API Key');
        setKeyInput('');
        try {
          applyConfig(await api.getConfig());
        } catch {
          setDesktopAvailable(false);
        }
      } else {
        setSaveError(result?.error || '清除失败，请重试');
      }
    } catch (error) {
      setSaveError(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const api = resolveAiReviewApi();
    if (!api) {
      setDesktopAvailable(false);
      return;
    }
    setTesting(true);
    try {
      const result = await api.testConnection();
      setTestResult(
        result?.ok
          ? { ok: true, text: '连接正常' }
          : { ok: false, text: result?.error || '连接失败' },
      );
    } catch (error) {
      setTestResult({ ok: false, text: describeError(error) });
    } finally {
      setTesting(false);
    }
  };

  if (!desktopAvailable) {
    return (
      <Alert
        type="warning"
        showIcon
        message="仅桌面端可用"
        description="AI 服务配置依赖桌面端 AI 模块，浏览器预览中不可用。"
      />
    );
  }

  return (
    <div className="settings-panel" style={{ width: '100%' }}>
      <div className="settings-row">
        <span className="pref-label">服务地址</span>
        <Input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="支持 https 或 http://localhost"
        />
      </div>
      <div className="settings-row">
        <span className="pref-label">模型</span>
        <Input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="例如 gpt-4o-mini"
        />
      </div>
      <div className="settings-row">
        <span className="pref-label">温度</span>
        <InputNumber
          min={0}
          max={2}
          step={0.1}
          value={temperature}
          onChange={(value) => setTemperature(typeof value === 'number' ? value : DEFAULT_TEMPERATURE)}
          style={{ width: '100%' }}
        />
      </div>
      <div className="settings-row">
        <span className="pref-label">API Key</span>
        <Input.Password
          value={keyInput}
          onChange={(event) => setKeyInput(event.target.value)}
          placeholder={hasKey ? '已保存（输入新值可覆盖）' : 'sk-...'}
          autoComplete="new-password"
        />
      </div>

      {saveError ? (
        <Alert type="error" showIcon message="保存失败" description={saveError} style={{ marginBottom: 8 }} />
      ) : null}
      {testResult ? (
        <Alert
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          message={testResult.ok ? '连接正常' : '连接失败'}
          description={testResult.ok ? undefined : testResult.text}
          style={{ marginBottom: 8 }}
        />
      ) : null}

      <Space>
        <Button type="primary" loading={saving} onClick={() => void handleSave()}>
          保存
        </Button>
        <Button loading={testing} onClick={() => void handleTest()}>
          测试连接
        </Button>
        {hasKey && !keyInput ? (
          <Button danger loading={saving} onClick={() => void handleClearKey()}>
            清除密钥
          </Button>
        ) : null}
      </Space>
      <Paragraph className="quiet-note" style={{ marginTop: 8, marginBottom: 0 }}>
        API Key 用系统密钥加密保存，不会回显；测试连接使用已保存的配置。
      </Paragraph>
    </div>
  );
}
