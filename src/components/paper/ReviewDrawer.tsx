import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input, Space, Typography } from 'antd';
import type { Paper } from '../../types/paperApp';
import {
  AI_CLAIM_LIMIT,
  AI_FIELD_LIMIT,
  AI_MAX_EVIDENCE,
  AI_REVIEW_MAX_PAPERS,
  buildReviewDigest,
  buildReviewMessages,
  resolveAiReviewApi,
} from '../../lib/reviewDigest';
import type { AiReviewApi, ReviewDigest } from '../../lib/reviewDigest';

const { Paragraph, Text } = Typography;
const { TextArea } = Input;

export type ReviewPhase = 'idle' | 'preview' | 'generating' | 'done' | 'stopped' | 'error';

export type ReviewDrawerProps = {
  open: boolean;
  onClose: () => void;
  papers: Paper[];
  onSaveMarkdown: (name: string, content: string) => void;
};

const listPanelStyle = {
  maxHeight: 320,
  overflowY: 'auto',
  border: '1px solid rgba(128, 128, 128, 0.25)',
  borderRadius: 8,
  padding: '8px 12px',
} as const;

const streamPanelStyle = {
  maxHeight: 420,
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 13,
  lineHeight: 1.7,
  border: '1px solid rgba(128, 128, 128, 0.25)',
  borderRadius: 8,
  padding: '8px 12px',
} as const;

export function ReviewDrawer({ open, onClose, papers, onSaveMarkdown }: ReviewDrawerProps) {
  const aiApi: AiReviewApi | null = resolveAiReviewApi();

  const [phase, setPhase] = useState<ReviewPhase>('idle');
  const [digest, setDigest] = useState<ReviewDigest | null>(null);
  const [streamText, setStreamText] = useState('');
  const [content, setContent] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const streamRef = useRef('');
  const unsubscribersRef = useRef<Array<() => void>>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const unsubscribeStream = () => {
    const unsubs = unsubscribersRef.current;
    unsubscribersRef.current = [];
    for (const unsubscribe of unsubs) {
      try {
        unsubscribe();
      } catch {
        // 忽略退订异常，保证其余监听器仍被移除
      }
    }
  };

  // 关闭抽屉：停掉订阅并回到 idle，重新打开时重新计算素材
  useEffect(() => {
    if (open) return;
    unsubscribeStream();
    setPhase('idle');
    setErrorMessage('');
  }, [open]);

  // idle：按当前筛选结果计算 digest，进入预览
  useEffect(() => {
    if (!open || phase !== 'idle') return;
    setDigest(buildReviewDigest(papers));
    setStreamText('');
    setContent('');
    setPhase('preview');
  }, [open, phase, papers]);

  // 卸载时退订流式事件
  useEffect(() => () => unsubscribeStream(), []);

  // 生成中：内容变化时自动滚动到底部
  useEffect(() => {
    if (phase !== 'generating') return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [streamText, phase]);

  const startPreview = () => {
    unsubscribeStream();
    setPhase('idle');
  };

  const startGenerate = () => {
    if (!aiApi || !digest || digest.selectedCount === 0) return;
    const messages = buildReviewMessages(digest);
    unsubscribeStream();
    streamRef.current = '';
    setStreamText('');
    setContent('');
    setErrorMessage('');
    setPhase('generating');

    unsubscribersRef.current = [
      aiApi.onChunk((delta) => {
        streamRef.current += typeof delta === 'string' ? delta : '';
        setStreamText(streamRef.current);
      }),
      aiApi.onDone((payload) => {
        const full =
          typeof payload?.full === 'string' && payload.full.length > 0
            ? payload.full
            : streamRef.current;
        streamRef.current = full;
        setStreamText(full);
        setContent(full);
        setPhase(payload?.stopped ? 'stopped' : 'done');
        unsubscribeStream();
      }),
      aiApi.onError((payload) => {
        setErrorMessage(payload?.message || '未知错误，请稍后重试');
        setPhase('error');
        unsubscribeStream();
      }),
    ];

    // generate-review 仅返回 { ok: true }，错误统一走 ai:review-error 事件；
    // invoke 本身异常（通道缺失等）时兜底进入错误态
    void aiApi.generateReview(messages).catch(() => {
      if (unsubscribersRef.current.length === 0) return;
      setErrorMessage('无法启动综述生成，请检查桌面端 AI 配置');
      setPhase('error');
      unsubscribeStream();
    });
  };

  const handleCancel = () => {
    void aiApi?.cancelReview();
  };

  // 关闭生成中抽屉 = 取消
  const handleClose = () => {
    if (phase === 'generating') {
      void aiApi?.cancelReview();
    }
    unsubscribeStream();
    onClose();
  };

  const renderContent = () => {
    const api = aiApi;
    if (!api) {
      return (
        <Alert
          type="warning"
          showIcon
          message="账户系统仅在桌面端可用"
          description="AI 综述依赖桌面端 AI 服务，当前环境无法生成。"
        />
      );
    }

    if (phase === 'idle' || !digest) {
      return <Paragraph className="quiet-note">正在准备综述素材…</Paragraph>;
    }

    if (digest.selectedCount === 0) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选没有论文" />;
    }

    if (phase === 'preview') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {digest.truncated ? (
            <Alert
              type="warning"
              showIcon
              message={`论文较多，仅取前 ${AI_REVIEW_MAX_PAPERS} 篇`}
              description={`每篇文本字段截断至 ${AI_FIELD_LIMIT} 字符，证据每篇最多 ${AI_MAX_EVIDENCE} 条，主张与定位截断至 ${AI_CLAIM_LIMIT} 字符。`}
            />
          ) : null}
          <Paragraph className="quiet-note" style={{ marginBottom: 0 }}>
            将发送 {digest.selectedCount} 篇论文（当前筛选共 {digest.totalCount} 篇），按标签分组提供素材。
          </Paragraph>
          <div style={listPanelStyle}>
            {digest.groups.map((group) => (
              <div key={group.tag} style={{ marginBottom: 8 }}>
                <div className="settings-panel-title" style={{ marginBottom: 2 }}>
                  {group.tag}（{group.papers.length}）
                </div>
                {group.papers.map((paper) => (
                  <div
                    key={`${group.tag}:${paper.id}`}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, lineHeight: 1.7 }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {paper.title || '未命名论文'}
                    </span>
                    <Text type="secondary">{paper.year}</Text>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <Button type="primary" block onClick={startGenerate}>
            开始生成
          </Button>
        </div>
      );
    }

    if (phase === 'generating') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Paragraph className="quiet-note" style={{ marginBottom: 0 }}>
            正在流式生成综述，可随时取消，已生成内容会保留。
          </Paragraph>
          <div ref={scrollRef} style={streamPanelStyle}>
            {streamText || '正在等待模型输出…'}
          </div>
          <Button block danger onClick={handleCancel}>
            取消
          </Button>
        </div>
      );
    }

    if (phase === 'done' || phase === 'stopped') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {phase === 'stopped' ? <Alert type="warning" showIcon message="已中断，可重新生成" /> : null}
          <TextArea
            rows={16}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="综述内容"
          />
          <Space>
            <Button onClick={startPreview}>重新生成</Button>
            <Button
              type="primary"
              disabled={!content.trim()}
              onClick={() => onSaveMarkdown('literature-review', content)}
            >
              另存为 Markdown
            </Button>
          </Space>
        </div>
      );
    }

    // error
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Alert
          type="error"
          showIcon
          message="综述生成失败"
          description={errorMessage || '未知错误，请稍后重试。'}
        />
        <Button block onClick={startPreview}>
          重试
        </Button>
      </div>
    );
  };

  return (
    <Drawer
      title="AI 综述"
      placement="right"
      width={480}
      open={open}
      onClose={handleClose}
      destroyOnClose={false}
      className="drawer-shell"
    >
      {renderContent()}
    </Drawer>
  );
}
