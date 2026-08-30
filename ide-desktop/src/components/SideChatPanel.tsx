import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Send, MessageSquare, Plus, Trash2, Loader2 } from 'lucide-react';
import type { AgentEvent, ChatItem, DesktopSettings } from '../types';
import { ConversationStream } from './ConversationStream';
import { desktop } from '../lib/ipc';

/*
 * SideChatPanel — 独立侧边聊天面板。
 *
 * 架构：侧边聊天与主对话共用同一个 agent bridge 进程。每个侧边 tab
 * 是一个轻量级的消息列表；发送时调用 desktop.agent.start/prompt，
 * 接收时监听 desktop.agent.onEvent。
 *
 * 限制：bridge 是单进程、单会话的，所以侧边聊天和主对话不能同时运行。
 * 当主对话 agentStatus !== 'offline' 时，发送按钮 disable 并给出提示。
 */

type SideAgentStatus = 'offline' | 'starting' | 'running';

type SideMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
};

type SideChat = {
  id: string;
  title: string;
  messages: SideMessage[];
};

export function SideChatPanel({
  open,
  width,
  mainAgentBusy,
  onClose,
  onWidthChange,
  settings,
}: {
  open: boolean;
  width: number;
  /** true when the main conversation agent is running/starting */
  mainAgentBusy: boolean;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  settings: DesktopSettings | null;
}) {
  const [chats, setChats] = useState<SideChat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [agentStatus, setAgentStatus] = useState<SideAgentStatus>('offline');
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const activeChat = chats.find((c) => c.id === activeId);

  // Subscribe to agent events so we can render assistant replies
  useEffect(() => {
    if (!open) return;
    const unsub = desktop.agent.onEvent((event: AgentEvent) => {
      // Only act on events relevant to side chat (agent is running for us)
      if (agentStatus === 'offline') return;

      if (event.type === 'assistant_message' || event.type === 'assistant_delta') {
        const text = String(event.text ?? event.delta ?? event.content ?? '');
        if (!text) return;
        setChats((prev) =>
          prev.map((c) => {
            if (c.id !== activeId) return c;
            const last = c.messages.at(-1);
            // If last is an in-progress assistant delta, append; otherwise add new
            if (last && last.role === 'assistant' && last.id.startsWith('stream-')) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === last.id ? { ...m, text: m.text + text } : m
                ),
              };
            }
            return {
              ...c,
              messages: [
                ...c.messages,
                { id: `stream-${Date.now()}`, role: 'assistant', text, ts: Date.now() },
              ],
            };
          })
        );
      }

      if (event.type === 'turn_done' || event.type === 'agent_offline') {
        setAgentStatus('offline');
        // Seal any open stream message (give it a stable id)
        setChats((prev) =>
          prev.map((c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id.startsWith('stream-') ? { ...m, id: `asst-${m.ts}` } : m
            ),
          }))
        );
      }

      if (event.type === 'error') {
        const errText = event.message ?? '发生错误';
        setChats((prev) =>
          prev.map((c) => {
            if (c.id !== activeId) return c;
            return {
              ...c,
              messages: [
                ...c.messages,
                { id: `err-${Date.now()}`, role: 'assistant', text: `⚠ ${errText}`, ts: Date.now() },
              ],
            };
          })
        );
        setAgentStatus('offline');
      }
    });
    return unsub;
  }, [open, agentStatus, activeId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chats]);

  function createChat() {
    const id = `side-${Date.now()}`;
    setChats((prev) => [...prev, { id, title: '新对话', messages: [] }]);
    setActiveId(id);
    setInput('');
  }

  function deleteChat(id: string) {
    setChats((prev) => {
      const rest = prev.filter((c) => c.id !== id);
      if (activeId === id) setActiveId(rest.at(-1)?.id ?? null);
      return rest;
    });
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || !activeChat) return;
    if (mainAgentBusy) return;
    setInput('');

    // Add user message immediately
    const userMsg: SideMessage = { id: `user-${Date.now()}`, role: 'user', text, ts: Date.now() };
    setChats((prev) =>
      prev.map((c) =>
        c.id === activeId
          ? {
              ...c,
              title: c.messages.length === 0 ? text.slice(0, 30) : c.title,
              messages: [...c.messages, userMsg],
            }
          : c
      )
    );

    try {
      setAgentStatus('starting');
      await desktop.agent.start();
      setAgentStatus('running');
      await desktop.agent.prompt(text);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setChats((prev) =>
        prev.map((c) =>
          c.id === activeId
            ? { ...c, messages: [...c.messages, { id: `err-${Date.now()}`, role: 'assistant', text: `⚠ ${errMsg}`, ts: Date.now() }] }
            : c
        )
      );
      setAgentStatus('offline');
    }
  }

  // Drag-to-resize
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: width };
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startX - e.clientX;
      const next = Math.max(280, Math.min(800, resizeRef.current.startWidth + delta));
      onWidthChange(next);
    }
    function onUp() { resizeRef.current = null; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onWidthChange]);

  if (!open) return null;

  const busy = agentStatus !== 'offline';
  const disabled = busy || mainAgentBusy;

  return (
    <aside className="side-chat-panel" style={{ width }}>
      {/* Drag handle */}
      <div className="side-chat-resize" onMouseDown={startResize} />

      <div className="side-chat-header">
        <div className="side-chat-title">
          <MessageSquare size={15} />
          <span>侧边对话</span>
        </div>
        <div className="side-chat-actions">
          <button className="icon-button" title="新建对话" onClick={createChat}>
            <Plus size={15} />
          </button>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </div>

      {chats.length === 0 ? (
        <div className="side-chat-empty">
          <MessageSquare size={32} style={{ opacity: 0.25, marginBottom: 12 }} />
          <p>还没有侧边对话</p>
          <button className="btn-primary" onClick={createChat}>
            <Plus size={14} /> 开始新对话
          </button>
        </div>
      ) : (
        <>
          {/* Tab bar */}
          {chats.length > 1 && (
            <div className="side-chat-tabs">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  className={`side-chat-tab ${chat.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(chat.id)}
                >
                  <span className="side-chat-tab-title">{chat.title}</span>
                  <button
                    className="side-chat-tab-close"
                    onClick={(e) => { e.stopPropagation(); deleteChat(chat.id); }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {activeChat && (
            <div className="side-chat-body">
              <div className="side-chat-messages">
                {activeChat.messages.map((msg) => (
                  <div key={msg.id} className={`side-msg side-msg-${msg.role}`}>
                    <div className="side-msg-text">{msg.text}</div>
                  </div>
                ))}
                {busy && (
                  <div className="side-msg side-msg-assistant">
                    <div className="side-msg-text side-msg-thinking">
                      <Loader2 size={14} className="spin" /> 思考中…
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {mainAgentBusy && (
                <div className="side-chat-notice">主对话进行中，完成后可继续</div>
              )}

              <div className="side-chat-input">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); }
                  }}
                  placeholder={disabled ? '等待对话结束…' : '输入消息… Enter 发送'}
                  rows={3}
                  disabled={disabled}
                />
                <button
                  className="icon-button"
                  onClick={() => void sendMessage()}
                  disabled={disabled || !input.trim()}
                  title="发送"
                >
                  {busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
