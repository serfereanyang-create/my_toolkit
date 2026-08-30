const https = require('https');
const http = require('http');

/**
 * 轻量级代码补全服务
 * 使用快速模型（Claude Haiku）进行代码补全
 * 独立于主 agent bridge，避免阻塞对话
 */
class CompletionService {
  constructor({ provider, model, baseUrl, apiKey }) {
    this.provider = provider;
    this.model = model || 'claude-3-5-haiku-20241022'; // 默认使用 Haiku
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.pendingRequests = new Map();
  }

  /**
   * 请求代码补全
   */
  async complete(prompt, options = {}) {
    const requestId = `completion-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    // 取消之前的请求（如果有）
    if (this.pendingRequests.size > 0) {
      for (const [id, controller] of this.pendingRequests) {
        controller.abort();
        this.pendingRequests.delete(id);
      }
    }

    const abortController = new AbortController();
    this.pendingRequests.set(requestId, abortController);

    try {
      let result;
      
      if (this.provider === 'anthropic') {
        result = await this.completeAnthropic(prompt, options, abortController.signal);
      } else if (this.provider === 'openai') {
        result = await this.completeOpenAI(prompt, options, abortController.signal);
      } else {
        throw new Error(`Unsupported provider: ${this.provider}`);
      }

      this.pendingRequests.delete(requestId);
      return result;
    } catch (err) {
      this.pendingRequests.delete(requestId);
      if (err.name === 'AbortError') {
        return null;
      }
      throw err;
    }
  }

  async completeAnthropic(prompt, options, signal) {
    const url = new URL(this.baseUrl || 'https://api.anthropic.com');
    url.pathname = '/v1/messages';

    const requestBody = {
      model: this.model,
      max_tokens: options.maxTokens || 256,
      temperature: 0.3, // 低温度，更确定性
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    };

    const response = await this.makeRequest({
      url: url.toString(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (response.content && response.content[0] && response.content[0].text) {
      return {
        text: response.content[0].text.trim(),
        model: response.model,
        usage: response.usage
      };
    }

    return null;
  }

  async completeOpenAI(prompt, options, signal) {
    const url = new URL(this.baseUrl || 'https://api.openai.com');
    url.pathname = '/v1/chat/completions';

    const requestBody = {
      model: this.model,
      max_tokens: options.maxTokens || 256,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    };

    const response = await this.makeRequest({
      url: url.toString(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (response.choices && response.choices[0] && response.choices[0].message) {
      return {
        text: response.choices[0].message.content.trim(),
        model: response.model,
        usage: response.usage
      };
    }

    return null;
  }

  makeRequest({ url, method, headers, body, signal }) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        method,
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = lib.request(parsedUrl, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`Invalid JSON response: ${err.message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);

      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('AbortError'));
        });
      }

      req.write(body);
      req.end();
    });
  }

  /**
   * 取消所有待处理的请求
   */
  cancelAll() {
    for (const [id, controller] of this.pendingRequests) {
      controller.abort();
      this.pendingRequests.delete(id);
    }
  }
}

module.exports = { CompletionService };
