import { Component, type ErrorInfo, type ReactNode } from 'react';

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

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-shell error-boundary">
        <section className="error-boundary-card" role="alert">
          <h1>界面遇到问题</h1>
          <p>{this.state.error.message || '发生了未知错误。'}</p>
          <button type="button" onClick={this.recover}>重试</button>
        </section>
      </main>
    );
  }
}
