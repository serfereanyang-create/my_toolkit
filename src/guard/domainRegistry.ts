import type { DomainMatch } from './types.js';

export type GuardContext = {
  recentDomains: string[];
};

export type DomainAdapter = {
  id: string;
  label: string;
  keywords: string[];
  intentPatterns: string[];
  requirementFields: string[];
  beginnerConcepts: string[];
  questionStrategies: string[];
  maxAttemptsOverride?: number;
};

export class DomainRegistry {
  private readonly adapters: DomainAdapter[] = [];

  register(adapter: DomainAdapter): void {
    this.adapters.push(adapter);
  }

  resolve(text: string, context: GuardContext): DomainMatch[] {
    const lower = text.toLowerCase();
    const matches = this.adapters
      .map((adapter) => {
        let score = 0;
        const reasons: string[] = [];

        for (const keyword of adapter.keywords) {
          if (lower.includes(keyword.toLowerCase())) {
            score += 18;
            reasons.push(keyword);
          }
        }

        for (const pattern of adapter.intentPatterns) {
          if (new RegExp(pattern, 'i').test(text)) {
            score += 22;
            reasons.push(pattern);
          }
        }

        if (context.recentDomains.includes(adapter.id)) {
          score += 8;
          reasons.push('recent-domain');
        }

        return {
          adapterId: adapter.id,
          label: adapter.label,
          confidence: Math.min(score / 100, 1),
          reasons,
        };
      })
      .filter((match) => match.confidence >= 0.2)
      .sort((left, right) => right.confidence - left.confidence);

    return matches.length > 0 ? matches : [{ adapterId: 'general', label: '通用需求', confidence: 0.25, reasons: ['fallback'] }];
  }

  getAll(): DomainAdapter[] {
    return [...this.adapters];
  }
}

export function createDefaultDomainRegistry(): DomainRegistry {
  const registry = new DomainRegistry();

  registry.register({
    id: 'software',
    label: '软件开发',
    keywords: ['网页', '按钮', '前端', '后端', '数据库', '接口', 'api', '保存', '登录', '组件', '页面', '代码', '迁移'],
    intentPatterns: ['做一个', '实现', '开发', '修复', '添加', '修改'],
    requirementFields: ['前端表现', '数据流', '接口或存储', '失败反馈', '测试点'],
    beginnerConcepts: ['input-output', 'failure-feedback', 'persistence', 'acceptance-criteria'],
    questionStrategies: ['decision', 'multiple-choice'],
  });

  registry.register({
    id: 'electronics',
    label: '电子信息',
    keywords: ['传感器', '采集', '温度', '电压', '滤波', '串口', '通信', '采样', '嵌入式', '曲线'],
    intentPatterns: ['采集', '测量', '控制', '通信'],
    requirementFields: ['采集对象', '接口', '精度', '时序', '可靠性'],
    beginnerConcepts: ['sampling', 'signal-noise', 'interface'],
    questionStrategies: ['decision'],
  });

  registry.register({
    id: 'content',
    label: '内容创作',
    keywords: ['文章', '视频', '脚本', '文案', '海报', '标题'],
    intentPatterns: ['写一篇', '生成', '改写'],
    requirementFields: ['受众', '风格', '素材', '结构', '交付格式'],
    beginnerConcepts: ['audience', 'style', 'structure'],
    questionStrategies: ['short-answer'],
  });

  registry.register({
    id: 'design',
    label: '设计与视觉',
    keywords: ['布局', '颜色', '动效', '界面', '图标', '视觉'],
    intentPatterns: ['设计', '美化', '排版'],
    requirementFields: ['场景', '布局', '色彩', '可访问性', '交付格式'],
    beginnerConcepts: ['layout', 'contrast', 'user-flow'],
    questionStrategies: ['decision'],
  });

  registry.register({
    id: 'game',
    label: '游戏或互动',
    keywords: ['游戏', '玩家', '关卡', '得分', '规则', '互动'],
    intentPatterns: ['做个.*游戏', '设计.*玩法'],
    requirementFields: ['玩家目标', '规则', '反馈', '失败条件', '平衡性'],
    beginnerConcepts: ['feedback-loop', 'rules', 'state'],
    questionStrategies: ['decision'],
  });

  return registry;
}
