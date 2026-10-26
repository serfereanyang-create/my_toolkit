/**
 * Monaco 的加载位置。
 *
 * 它原来在 `main.tsx` 顶层 `import * as monaco from 'monaco-editor'`，结果是
 * 整个编辑器（含全部语言服务）挤进首屏那个 5MB 的 chunk：每次启动都要先把
 * 它解析一遍，哪怕这一整场都没人打开文件。这里把它挪进一个只有编辑器才会
 * 触发的动态 import，首屏入口因此不再包含 Monaco。
 *
 * 顺序不能反：`loader.config({ monaco })` 必须在第一个 `<Editor>`挂载之前执行，
 * 否则 @monaco-editor/react 会退到去 jsdelivr 拉 monaco——那个地址在这套离线
 * 桌面环境里根本连不上，编辑器就永远停在「Loading…」。
 */

type MonacoWorkerFactory = new (options?: WorkerOptions) => Worker;

/** `?worker` 让 Vite 把每个 worker 打成独立文件；模块本身是懒加载的，所以这些
 *  几十 MB 的 worker 只会在真的用到编辑器时才会被请求。 */
const workerFactories = import.meta.glob([
  '/node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
  '/node_modules/monaco-editor/esm/vs/language/json/json.worker.js',
  '/node_modules/monaco-editor/esm/vs/language/css/css.worker.js',
  '/node_modules/monaco-editor/esm/vs/language/html/html.worker.js',
  '/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js',
], {
  query: '?worker',
  import: 'default',
  eager: true,
}) as Record<string, MonacoWorkerFactory>;

function workerFactoryFor(label: string): MonacoWorkerFactory | undefined {
  if (label === 'json') return workerFactories['/node_modules/monaco-editor/esm/vs/language/json/json.worker.js'];
  if (label === 'css' || label === 'scss' || label === 'less') return workerFactories['/node_modules/monaco-editor/esm/vs/language/css/css.worker.js'];
  if (label === 'html' || label === 'handlebars' || label === 'razor') return workerFactories['/node_modules/monaco-editor/esm/vs/language/html/html.worker.js'];
  if (label === 'typescript' || label === 'javascript') return workerFactories['/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js'];
  return workerFactories['/node_modules/monaco-editor/esm/vs/editor/editor.worker.js'];
}

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker;
    };
  }
}

let loading: Promise<void> | null = null;

/**
 * 加载并配置 Monaco，重复调用只加载一次。
 *
 * 失败要把 `loading` 清掉：一次磁盘抖动之后，用户再点开文件应该还能重试，
 * 而不是被一个缓存的 rejected promise 永久钉死在「编辑器加载失败」。
 */
export function ensureMonaco(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      const [monacoModule, reactWrapper] = await Promise.all([
        import('monaco-editor'),
        import('@monaco-editor/react'),
      ]);
      window.MonacoEnvironment = {
        getWorker(_workerId: string, label: string) {
          const WorkerFactory = workerFactoryFor(label);
          if (!WorkerFactory) throw new Error(`没有找到 ${label} 的编辑器 worker`);
          return new WorkerFactory({ name: label });
        },
      };
      reactWrapper.loader.config({ monaco: monacoModule });
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}
