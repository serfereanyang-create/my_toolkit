/**
 * helpContent.ts — 版本化的新功能与帮助内容
 *
 * 每个发布周期在 WHATS_NEW 顶部追加一版；HelpOverlay 按 app 版本选择
 * 高亮条目，不再显示占位文案。内容描述的都是已接通的真实能力。
 */

export type WhatsNewEntry = {
  version: string;
  date: string;
  highlights: string[];
};

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '0.1.0',
    date: '2026-09-05',
    highlights: [
      '质量工作台：代码审查、覆盖率、性能分析、复杂度/异味/依赖仪表盘与重构面板，全部通过只读工具网关实时分析',
      '质量面板结果带工作区版本戳，分支/提交/文件状态变化后自动提示过期并可一键重新分析',
      '编辑器行号跳转：从分析结果点击即可打开文件并定位到对应行',
      '编辑器设置真实生效：缩进宽度、小地图、自动换行、代码字号即时应用',
      '多厂商模型支持：Grok/xAI、GLM/智谱、Kimi/Moonshot、DeepSeek 一等公民接入，自动适配端点与推理参数',
      '提示缓存策略：Anthropic 显式断点 + OpenAI 兼容厂商自动前缀缓存（稳定头部/动态尾部），/cache 可诊断',
      '预览安全加固：工作区路径规范化、symlink 逃逸拦截、preview token 校验、敏感目录/文件阻断',
      '自动化生产化：/automate run 真实执行、触发器更新先停旧监听、runtime 退出统一清理',
      '后台命令：run_command 支持 background + poll_command 分批读取，超时清理进程树',
    ],
  },
];

export type HelpTopic = {
  id: string;
  title: string;
  body: string[];
};

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'quickstart',
    title: '快速上手',
    body: [
      '左侧栏选择或打开一个工作区目录，首次启动会自动恢复最近的项目。',
      '在对话视图直接用自然语言下达任务；@ 可引用文件与符号，/ 唤起命令面板。',
      '复杂任务会自动建立任务板（计划确认后逐项执行），编辑器顶部可看到进行中的任务。',
    ],
  },
  {
    id: 'quality',
    title: '质量工作台',
    body: [
      '顶部"质量"标签打开仪表盘：复杂度、代码异味、依赖关系三项 AST 分析并行执行。',
      '仪表盘下方的启动器可打开代码审查、覆盖率、性能分析与重构面板；审查与性能默认分析当前编辑的文件。',
      '覆盖率面板读取 coverage/coverage-summary.json（nyc / c8 / vitest --coverage 均可生成）。',
      '所有结果带工作区版本戳：工作区变更后横幅提示过期，点击"重新分析"刷新。',
    ],
  },
  {
    id: 'editor',
    title: '编辑器',
    body: [
      'Ctrl/Cmd+S 保存当前文件；保存前会比对磁盘修改时间，外部改动不会静默覆盖。',
      'Agent 修改过的行在编辑器中有蓝色高亮；标签页上的 ! 表示磁盘内容与本地编辑冲突。',
      '设置 → 外观 可调整缩进宽度、小地图、自动换行与字号，保存后立即生效。',
    ],
  },
  {
    id: 'automation',
    title: '自动化',
    body: [
      '/automate create 按模板创建定时、文件监听或 Git 事件任务；/automate run 立即执行一次。',
      '文件监听触发器在保存匹配模式的文件后自动执行目标；连续失败会自动禁用并记录原因。',
    ],
  },
  {
    id: 'providers',
    title: '模型与缓存',
    body: [
      '设置 → 模型 中可配置 OpenAI、Anthropic、Gemini、Grok、GLM、Kimi、DeepSeek 及任意 OpenAI 兼容端点。',
      '选择厂商预设会自动填充官方端点、协议格式与常用模型；API Key 保存在系统密钥库。',
      '/cache 查看当前会话的提示缓存命中率与诊断建议。',
    ],
  },
];
