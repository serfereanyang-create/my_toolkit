import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Copy, RefreshCw } from 'lucide-react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Keeps a render-time component failure from leaving a blank Electron window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[UI ErrorBoundary]', error, info.componentStack);
  }

  private recover = () => {
    this.setState({ error: null });
  };

  private reload = () => window.location.reload();

  private copyError = () => {
    const message = this.state.error?.stack || this.state.error?.message || '未知界面错误';
    void navigator.clipboard?.writeText(message);
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-shell error-boundary">
        <section className="error-boundary-card" role="alert">
          <h1>界面遇到问题</h1>
          <p>{this.state.error.message || '发生了未知错误。'}</p>
          <div className="error-boundary-actions">
            <button type="button" onClick={this.recover}><RefreshCw size={14} />重试界面</button>
            <button type="button" onClick={this.reload}><RefreshCw size={14} />重新载入</button>
            <button type="button" onClick={this.copyError}><Copy size={14} />复制错误</button>
          </div>
        </section>
      </main>
    );
  }
}
