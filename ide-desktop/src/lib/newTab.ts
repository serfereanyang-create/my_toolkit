/**
 * newTab.ts — 侧边栏「新标签页」的数据与规则
 *
 * 这一页只做一件事：把「打开什么」列成人能点的东西。规则留在这里而不是组件
 * 里，是因为它们全都可以单独验算——快捷项映射到哪个动作、哪些插件能出现在
 * 工件区、选中的绝对路径能不能落进工作区——组件只负责画。
 */
import type { PluginDef, PluginStatus } from './plugins';

/** 新标签页上方的五个常用入口。 */
export type NewTabAction = 'files' | 'browser' | 'terminal' | 'review' | 'sidechat';

export type NewTabShortcut = {
  action: NewTabAction;
  title: string;
  desc: string;
};

export const NEW_TAB_SHORTCUTS: readonly NewTabShortcut[] = [
  { action: 'files', title: '文件', desc: '从目录中选择一个文件…' },
  { action: 'browser', title: '浏览器', desc: '浏览网页和预览应用…' },
  { action: 'terminal', title: '终端', desc: '运行命令和查看输出…' },
  { action: 'review', title: '审查', desc: '查看代码变更与差异…' },
  { action: 'sidechat', title: '辅助对话', desc: '在侧边面板中继续对话' },
] as const;

/** 工件区固定展示这四种文档插件，顺序按日常使用频率排。 */
export const ARTIFACT_PLUGIN_IDS = ['pdf', 'presentations', 'spreadsheets', 'documents'] as const;

export type ArtifactPluginId = (typeof ARTIFACT_PLUGIN_IDS)[number];

/** 「打开」时给系统选择框的过滤器：插件 id → 扩展名。 */
export const ARTIFACT_FILTERS: Record<ArtifactPluginId, { label: string; extensions: string[] }> = {
  pdf: { label: 'PDF', extensions: ['pdf'] },
  presentations: { label: '演示文稿', extensions: ['pptx', 'ppt'] },
  spreadsheets: { label: '电子表格', extensions: ['xlsx', 'xls', 'csv'] },
  documents: { label: 'Word 文档', extensions: ['docx', 'doc'] },
};

/** 选中系统对话框时这些格式也允许，但预览侧只认得上面四种的现代版本。 */
export const ARTIFACT_LEGACY_NOTE: Partial<Record<ArtifactPluginId, string>> = {
  presentations: '老版 .ppt 需要先另存为 .pptx 才能预览',
  spreadsheets: '老版 .xls 需要先另存为 .xlsx 才能预览',
  documents: '老版 .doc 需要先另存为 .docx 才能预览',
};

export type ArtifactTile = {
  id: ArtifactPluginId;
  name: string;
  desc: string;
  /** 注册表说它在这个环境里可用；不可用时按钮禁用并给出原因。 */
  available: boolean;
  reason: string | null;
};

/**
 * 把插件注册表筛成新标签页的四个工件格。
 *
 * 走注册表而不是写死列表，是为了「插件被关掉就不该还摆在那里假装能点」：
 * 用户可以在设置里禁用插件，而这一页必须和设置页说同一句话。
 */
export function artifactTiles(
  defs: readonly PluginDef[],
  status: PluginStatus | null,
): ArtifactTile[] {
  const byId = new Map(defs.map((def) => [def.id, def]));
  const availability = new Map((status?.plugins ?? []).map((entry) => [entry.id, entry]));
  return ARTIFACT_PLUGIN_IDS.flatMap((id) => {
    const def = byId.get(id);
    if (!def) return [];
    const entry = availability.get(id);
    return [{
      id,
      // 名字用中文标签而不是注册表里的英文名（PDF / Presentations / …）：
      // 这一页和侧栏其他文字同处一屏，混着两种语言很突兀；描述沿用注册表，
      // 因为那本来就是给用户看的说明，插件改名时这里会自动跟上。
      name: ARTIFACT_FILTERS[id].label,
      desc: def.desc,
      available: entry ? entry.available : true,
      reason: entry?.reason ?? null,
    }];
  });
}

/**
 * 绝对路径 → 工作区相对路径；落在工作区外面返回 null。
 *
 * 为什么非要转：预览、读文件、媒体缓存这几个 IPC 都只收工作区相对路径
 * （`resolveWorkspacePath` 会拦截越界），所以从这里放进去的绝对路径必须在
 * 进门之前就换成相对路径，越界的就地拒绝并告诉用户，而不是让它到主进程
 * 才失败。
 */
export function toWorkspaceRelative(root: string, absolute: string): string | null {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalize(root);
  const target = normalize(absolute);
  if (!base) return null;
  const lowerBase = base.toLowerCase();
  const lowerTarget = target.toLowerCase();
  if (lowerTarget === lowerBase) return '';
  if (!lowerTarget.startsWith(`${lowerBase}/`)) return null;
  return target.slice(base.length + 1);
}
