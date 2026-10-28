import React, { useEffect, useState } from 'react';
import { PlayCircle, AlertCircle, Loader, PackagePlus, RefreshCw } from 'lucide-react';
import type { PreviewTab, ProjectDescriptor } from '../../types';
import type { AppAction } from '../../lib/state';
import { desktop } from '../../lib/ipc';
import { scrollBehavior } from '../../lib/reduceMotion';

type Props = { tab: PreviewTab; dispatch: React.Dispatch<AppAction>; workspaceRoot: string };

export function RuntimeStatus({ tab, dispatch, workspaceRoot }: Props) {
  const desc = tab.descriptor as ProjectDescriptor;
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    return desktop.preview.onLog(({ token, line }) => {
      if (token === desc.token || token === 'install') {
        setLogs((prev) => [...prev.slice(-200), line]);
      }
    });
  }, [desc.token]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: scrollBehavior() });
  }, [logs]);

  // Auto-start static sites that already have a built index.html
  useEffect(() => {
    if (tab.status === 'loading' && desc.staticEntry && !desc.recommendedScript) {
      startStatic();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startStatic() {
    dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'starting' } });
    const rootRel = desc.relativePath || '.';
    const res = await desktop.preview.startStatic(rootRel, desc.token);
    if (res.ok && res.port) {
      const url = `http://127.0.0.1:${res.port}/`;
      dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'loading', webUrl: url, allowedPort: res.port } });
      await desktop.preview.show(url, res.port);
    } else {
      dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'error', error: res.error } });
    }
  }

  async function installAndStart() {
    dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'installing' } });
    setLogs([]);
    const res = await desktop.preview.installDeps(desc.relativePath, desc.pkgManager);
    if (!res.ok || res.canceled) {
      dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'ready' } });
      return;
    }
    await startDev();
  }

  async function startDev() {
    const script = desc.recommendedScript ?? 'dev';
    dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'starting' } });
    setLogs([]);
    const res = await desktop.preview.startDevServer(desc.relativePath, script, desc.pkgManager, desc.token);
    if (res.ok && res.port) {
      const url = `http://127.0.0.1:${res.port}/`;
      dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'loading', webUrl: url, allowedPort: res.port } });
      await desktop.preview.show(url, res.port);
    } else {
      dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'error', error: res.error } });
    }
  }

  // If already serving (webUrl is set), the native view is shown — render transparent overlay
  if (tab.webUrl && (tab.status === 'loading' || tab.status === 'ready')) {
    return <div className="preview-web-active" aria-label="Web 预览加载中" />;
  }

  return (
    <div className="runtime-status">
      <div className="runtime-status-header">
        <span className="runtime-name">{desc.name}</span>
        <span className="runtime-framework">{desc.framework}</span>
      </div>

      {(tab.status === 'starting' || tab.status === 'installing') && (
        <div className="runtime-status-body">
          <Loader size={20} className="spin" />
          <span>{tab.status === 'installing' ? '安装依赖…' : '启动开发服务器…'}</span>
          {logs.length > 0 && (
            <div className="runtime-logs">
              {logs.map((line, i) => <div key={i} className="runtime-log-line">{line}</div>)}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      )}

      {tab.status === 'error' && (
        <div className="runtime-status-body">
          <AlertCircle size={20} className="text-error" />
          <span className="text-error">{tab.error || '启动失败'}</span>
          <button className="btn-primary" onClick={startDev}><RefreshCw size={14} /> 重试</button>
        </div>
      )}

      {tab.status === 'ready' && (
        <div className="runtime-status-body">
          {desc.needsInstall ? (
            <>
              <PackagePlus size={22} opacity={0.6} />
              <p>项目缺少 node_modules</p>
              <p className="runtime-detail">包管理器：{desc.pkgManager}</p>
              <button className="btn-primary" onClick={installAndStart}>
                <PackagePlus size={14} /> 安装依赖并运行
              </button>
              {desc.staticEntry && (
                <button className="btn-secondary" onClick={startStatic}>
                  <PlayCircle size={14} /> 仅预览构建产物
                </button>
              )}
            </>
          ) : (
            <>
              <PlayCircle size={22} opacity={0.6} />
              <p>Web 应用：{desc.recommendedScript ? `npm run ${desc.recommendedScript}` : '静态站点'}</p>
              <button className="btn-primary" onClick={desc.recommendedScript ? startDev : startStatic}>
                <PlayCircle size={14} /> 运行
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
