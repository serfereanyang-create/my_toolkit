import type { AgentEvent, AppState, ChatItem, DesktopSettings, EditorTab, TreeNode } from '../types';

export type AppAction =
  | { type: 'settings/loaded'; settings: DesktopSettings }
  | { type: 'workspace/opened'; root: string }
  | { type: 'tree/loaded'; tree: TreeNode[] }
  | { type: 'view/set'; view: AppState['activeView'] }
  | { type: 'tab/opened'; tab: EditorTab }
  | { type: 'tab/changed'; path: string; content: string }
  | { type: 'tab/saved'; path: string; content: string }
  | { type: 'tab/activate'; path: string }
  | { type: 'chat/user'; text: string }
  | { type: 'agent/status'; status: AppState['agentStatus'] }
  | { type: 'agent/event'; event: AgentEvent }
  | { type: 'bottom/toggle' };

export const initialState: AppState = {
  workspaceRoot: '',
  activeView: 'files',
  settings: null,
  tree: [],
  tabs: [],
  activeTabPath: '',
  chat: [],
  agentStatus: 'offline',
  bottomOpen: false,
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'settings/loaded':
      return { ...state, settings: action.settings };
    case 'workspace/opened':
      return { ...state, workspaceRoot: action.root, tree: [], tabs: [], activeTabPath: '', agentStatus: 'offline' };
    case 'tree/loaded':
      return { ...state, tree: action.tree };
    case 'view/set':
      return { ...state, activeView: action.view };
    case 'tab/opened': {
      const tabs = state.tabs.some((tab) => tab.path === action.tab.path) ? state.tabs : [...state.tabs, action.tab];
      return { ...state, tabs, activeTabPath: action.tab.path };
    }
    case 'tab/changed':
      return { ...state, tabs: state.tabs.map((tab) => tab.path === action.path ? { ...tab, content: action.content } : tab) };
    case 'tab/saved':
      return { ...state, tabs: state.tabs.map((tab) => tab.path === action.path ? { ...tab, content: action.content, savedContent: action.content } : tab) };
    case 'tab/activate':
      return { ...state, activeTabPath: action.path };
    case 'chat/user':
      return { ...state, chat: [...state.chat, { id: `user-${Date.now()}`, kind: 'user', text: action.text }] };
    case 'agent/status':
      return { ...state, agentStatus: action.status };
    case 'agent/event':
      return reduceAgentEvent(state, action.event);
    case 'bottom/toggle':
      return { ...state, bottomOpen: !state.bottomOpen };
    default:
      return state;
  }
}

function reduceAgentEvent(state: AppState, event: AgentEvent): AppState {
  if (event.type === 'bridge_ready') return { ...state, agentStatus: 'ready' };
  if (event.type === 'turn_start') return { ...state, agentStatus: 'running' };
  if (event.type === 'turn_done') return { ...state, agentStatus: 'ready' };
  if (event.type === 'agent_offline') return { ...state, agentStatus: 'offline' };
  if (event.type === 'assistant_delta') return appendAssistantDelta(state, String(event.text || ''));
  if (event.type === 'assistant_message') return appendChat(state, { id: `assistant-${Date.now()}`, kind: 'assistant', text: String(event.text || '') });
  if (event.type === 'tool_start') return appendChat(state, { id: `tool-${Date.now()}`, kind: 'tool', status: 'running', tool: String(event.tool || 'tool'), input: event.input });
  if (event.type === 'tool_result') return appendChat(state, { id: `tool-${Date.now()}`, kind: 'tool', status: event.ok === false ? 'failed' : 'done', tool: String(event.tool || 'tool'), output: String(event.output || ''), ok: Boolean(event.ok) });
  if (event.type === 'approval_needed') return appendChat(state, { id: String(event.requestId || `approval-${Date.now()}`), kind: 'approval', requestId: String(event.requestId || ''), tool: String(event.tool || 'tool'), message: String(event.message || 'Approval required'), input: event.input });
  if (event.type === 'error') return appendChat(state, { id: `assistant-error-${Date.now()}`, kind: 'assistant', text: String(event.message || 'Agent error') });
  return state;
}

function appendAssistantDelta(state: AppState, text: string): AppState {
  const last = state.chat[state.chat.length - 1];
  if (last?.kind === 'assistant' && last.id === 'assistant-live') {
    return { ...state, chat: [...state.chat.slice(0, -1), { ...last, text: `${last.text}${text}` }] };
  }
  return appendChat(state, { id: 'assistant-live', kind: 'assistant', text });
}

function appendChat(state: AppState, item: ChatItem): AppState {
  return { ...state, chat: [...state.chat, item] };
}

export function languageForPath(path: string) {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.cjs') || path.endsWith('.mjs')) return 'javascript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.html')) return 'html';
  return 'plaintext';
}
