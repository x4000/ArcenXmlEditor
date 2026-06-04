import React from 'react';

// Top-level safety net for a whole window host (App / DetachedApp). A render-
// time throw anywhere below would otherwise unmount the entire React root and
// leave a blank white window — and the error only reaches DevTools, never the
// terminal. This catches it and shows the message + component stack on screen,
// selectable, with Reload / Copy actions. Inner boundaries (e.g. the sidebar's)
// still catch first; this is the backstop for everything they don't.

const BTN = {
  padding: '5px 14px', fontSize: 12, cursor: 'pointer',
  border: '1px solid var(--border, #555)', borderRadius: 3,
  background: 'var(--tab-bg, #333)', color: '#fff',
};

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
    this.handleCopy = this.handleCopy.bind(this);
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // Best-effort console trail for DevTools; never let logging itself throw.
    try {
      console.error('[App crash]', error, info && info.componentStack);
    } catch (_) { /* ignore */ }
  }

  details() {
    const e = this.state.error;
    const stack = (e && (e.stack || e.message)) || String(e);
    const comp = this.state.info && this.state.info.componentStack;
    return comp ? `${stack}\n\nComponent stack:${comp}` : String(stack);
  }

  handleCopy() {
    try {
      navigator.clipboard.writeText(this.details()).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  handleReload() {
    try {
      window.location.reload();
    } catch (_) { /* ignore */ }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const label = this.props.label ? ` (${this.props.label})` : '';
    return (
      <div style={{
        position: 'fixed', inset: 0, overflow: 'auto', padding: 20, zIndex: 100000,
        background: 'var(--bg, #1e1e1e)', color: 'var(--text, #ddd)',
        fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace", fontSize: 12,
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#c5384c', marginBottom: 4 }}>
          Something crashed{label}
        </div>
        <div style={{ marginBottom: 12, color: 'var(--text-dim, #999)' }}>
          The window was kept alive so you can read the error. Reload to recover.
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button onClick={this.handleReload} style={BTN}>Reload window</button>
          <button onClick={this.handleCopy} style={BTN}>Copy details</button>
        </div>
        <pre style={{
          whiteSpace: 'pre-wrap', userSelect: 'text', margin: 0, padding: 12, borderRadius: 4,
          background: 'var(--search-bg, rgba(0,0,0,0.3))', border: '1px solid var(--border, #444)',
        }}>
          {this.details()}
        </pre>
      </div>
    );
  }
}
