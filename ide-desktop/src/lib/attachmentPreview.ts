import type { DetectedFile } from './fileDetection';

/**
 * 附件缩略图。
 *
 * 这里刻意不 `import { desktop } from './ipc'`：那个模块在顶层读
 * `window.zcodeDesktop`，一 import 就把整个组件树钉在 Electron 上，node 环境
 * 下的单元测试连渲染都跑不起来。窗口对象按需取，拿不到就当没有原生能力。
 */

type ThumbnailSource = {
  fs?: { readImageDataUrl?: (absolutePath: string) => Promise<string> };
};

function nativeApi(): ThumbnailSource | undefined {
  const scope = globalThis as { zcodeDesktop?: ThumbnailSource };
  return scope.zcodeDesktop;
}

/** 主进程那边的上限，和 ipc.cjs 里的校验一致。 */
export const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

/**
 * 给图片附件补一张缩略图。任何一步失败都原样返回：附件本身照样能发出去，
 * 只是没图看，不值得为此弹一个错误。
 */
export async function withThumbnail(file: DetectedFile): Promise<DetectedFile> {
  if (file.preview) return file;
  if (file.category !== 'image') return file;
  if (!file.path) return file;
  if (file.size > MAX_THUMBNAIL_BYTES) return file;
  const read = nativeApi()?.fs?.readImageDataUrl;
  if (!read) return file;
  try {
    const preview = await read(file.path);
    return preview ? { ...file, preview } : file;
  } catch {
    return file;
  }
}

/** 批量补缩略图，顺序与入参一致。 */
export async function withThumbnails(files: DetectedFile[]): Promise<DetectedFile[]> {
  return Promise.all(files.map(withThumbnail));
}
