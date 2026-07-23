import type { GitAuditLog } from './audit.js';
import { assertObjectId, assertSafeRef, sanitizeRemote, type GitProcess } from './git.js';
import type { Locale } from '../i18n/locale.js';
import { formatGitConfirm } from '../i18n/messages.js';

export type GitPublishRequest = {
  remote: string;
  localRef: string;
  remoteBranch: string;
  sessionId: string;
  locale?: Locale;
};

export interface GitRemotePublisher {
  preview(request: GitPublishRequest): Promise<{ remote: string; localOid: string; destination: string }>;
  publish(request: GitPublishRequest, confirm?: (message: string) => Promise<boolean>): Promise<{ ok: boolean; reason: string }>;
}

export class LocalGitPublisher implements GitRemotePublisher {
  constructor(
    private readonly workspaceRoot: string,
    private readonly git: GitProcess,
    private readonly audit: GitAuditLog,
  ) {}

  async preview(request: GitPublishRequest) {
    validatePublishRequest(request);
    const localOid = assertObjectId((await this.git.text(['rev-parse', request.localRef])).trim());
    const remoteUrl = sanitizeRemote((await this.git.text(['remote', 'get-url', request.remote])).trim());
    return {
      remote: remoteUrl,
      localOid,
      destination: `refs/heads/${request.remoteBranch}`,
    };
  }

  async publish(request: GitPublishRequest, confirm?: (message: string) => Promise<boolean>) {
    validatePublishRequest(request);
    if (!confirm) {
      await this.append('push_declined', request, 'No confirmation callback available.');
      return { ok: false, reason: 'No confirmation callback available.' };
    }

    const preview = await this.preview(request);
    await this.append('push_requested', request, undefined, preview);
    const locale = request.locale ?? 'en';
    const accepted = await confirm(formatGitConfirm({
      locale,
      kind: 'publish',
      remote: preview.remote,
      localRef: `${preview.localOid.slice(0, 12)} (${request.localRef})`,
      remoteBranch: preview.destination,
    }));
    if (!accepted) {
      await this.append('push_declined', request, 'User declined publication.', preview);
      return { ok: false, reason: locale === 'zh' ? '用户拒绝了推送。' : 'User declined publication.' };
    }

    try {
      await this.git.text(['push', request.remote, `${preview.localOid}:refs/heads/${request.remoteBranch}`]);
      await this.append('push_succeeded', request, undefined, preview);
      return { ok: true, reason: 'Published successfully.' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.append('push_failed', request, reason, preview);
      return { ok: false, reason };
    }
  }

  private async append(
    type: 'push_requested' | 'push_declined' | 'push_succeeded' | 'push_failed',
    request: GitPublishRequest,
    error?: string,
    preview?: { remote: string; localOid: string; destination: string },
  ) {
    await this.audit.append({
      version: 1,
      id: `event_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`,
      type,
      timestamp: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      sessionId: request.sessionId,
      remote: preview?.remote ?? sanitizeRemote(request.remote),
      localRef: request.localRef,
      remoteBranch: request.remoteBranch,
      error,
    });
  }
}

function validatePublishRequest(request: GitPublishRequest) {
  if (!/^[A-Za-z0-9._-]+$/.test(request.remote)) throw new Error('Invalid remote name.');
  if (request.remote.includes('://')) throw new Error('Remote must be a configured remote name, not a URL.');
  assertSafeRef(request.localRef);
  if (request.localRef.startsWith('refs/aicode/checkpoints/')) {
    throw new Error('Publishing hidden checkpoint refs is prohibited.');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(request.remoteBranch) || request.remoteBranch.includes('..') || request.remoteBranch.startsWith('-')) {
    throw new Error('Invalid remote branch.');
  }
  if (request.remoteBranch.includes(':') || request.remoteBranch.includes('*') || request.remoteBranch.startsWith('refs/')) {
    throw new Error('Invalid remote branch refspec.');
  }
}
