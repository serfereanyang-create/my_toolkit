/**
 * provider-adapter.ts — AI 模块的 provider 适配层
 * 
 * explainer/reviewer 以简化形态调用 LLM：
 *   provider.complete({ messages: [{role,content}], model, temperature, maxTokens })
 *     → { content: string }
 * 
 * 本适配器把该调用桥接到 CLI 现有的 createProvider(AppConfig)：
 * - 补齐 AgentMessage.createdAt 与 ProviderRequest 的 tools/workspaceRoot
 * - 从 ProviderResponse.actions 中提取 message 文本作为 content
 * 
 * providerConfig 为空时抛出明确错误，提示用户先配置 provider。
 */

import { createProvider } from '../providers/index.js';
import type { AgentMessage, ProviderRequest } from '../providers/types.js';
import type { AppConfig } from '../config/types.js';

/**
 * AI 工具接受的最小 provider 配置
 */
export interface AIProviderConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  [key: string]: unknown;
}

/**
 * 简化的补全请求（explainer/reviewer 使用的形态）
 */
export interface SimpleCompletionRequest {
  messages: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 简化的补全响应
 */
export interface SimpleCompletionResponse {
  content: string;
}

/**
 * 简化的 provider 接口
 */
export interface SimpleProvider {
  complete(request: SimpleCompletionRequest): Promise<SimpleCompletionResponse>;
}

/**
 * 由 AI 工具配置创建简化 Provider。
 * workspaceRoot 由调用方（工具上下文）传入并如实透传给 provider；
 * 绝不回退 process.cwd()——那是 CLI 安装目录，会让"同一个相对路径
 * 两套解析根"类 bug 在 Windows 下反复出现。
 */
export function createProviderForConfig(config: AIProviderConfig, workspaceRoot: string): SimpleProvider {
  if (!config || Object.keys(config).length === 0) {
    throw new Error(
      'AI 工具未配置 provider。请在配置中提供 provider/model/apiKey，' +
      '或设置 OPENAI_API_KEY / ANTHROPIC_API_KEY 环境变量。'
    );
  }
  
  // 将简化配置映射为 AppConfig 的最小子集；
  // createProvider 只读取 provider 相关字段。
  const appConfig = {
    provider: (config.provider as AppConfig['provider']) ?? 'openai',
    model: config.model ?? 'gpt-4o-mini',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  } as unknown as AppConfig;
  
  const provider = createProvider(appConfig);
  
  return {
    async complete(request: SimpleCompletionRequest): Promise<SimpleCompletionResponse> {
      const now = new Date().toISOString();
      
      const messages: AgentMessage[] = request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: now,
      }));
      
      const providerRequest: ProviderRequest = {
        messages,
        tools: [],
        workspaceRoot,
      };
      
      const response = await provider.complete(providerRequest);
      
      // 从 actions 中收集 message 文本
      const content = response.actions
        .filter((action): action is { type: 'message'; content: string } => action.type === 'message')
        .map((action) => action.content)
        .join('\n');
      
      return { content };
    },
  };
}

/**
 * 便捷方法：单轮文本补全
 */
export async function completeText(
  config: AIProviderConfig,
  prompt: string,
  workspaceRoot: string,
  options: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const provider = createProviderForConfig(config, workspaceRoot);
  const response = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    model: config.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });
  return response.content;
}
