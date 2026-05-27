import React, { useEffect, useRef, useState } from 'react';

// Grammar LLM settings modal — Phase 2 of the grammar checker rebuild.
// Opens in response to a `grammarSettingsRequested` custom event so the same
// instance can be opened from the Grammar Check button in the validator
// window (via IPC) or from anywhere else in the main app.
//
// All persistence runs through main-process IPC: the API key never lives in
// renderer state longer than a single edit session, and the saved file lives
// in the platform user-settings directory rather than next to project data.

export default function GrammarSettings() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, error? } | null
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef(null);

  // Load on first open. We refetch each open so external edits to the
  // settings file (e.g. user editing it directly) are picked up.
  const reload = async () => {
    try {
      const settings = await window.arcenApi.grammarLLMLoadSettings();
      setEnabled(!!settings.enabled);
      setApiKey(settings.apiKey || '');
      setModel(settings.model || '');
      setTestResult(null);
    } catch (e) {
      console.error('Failed to load grammar LLM settings:', e);
    }
    try {
      const ms = await window.arcenApi.grammarLLMSupportedModels();
      setModels(ms.models || []);
      setDefaultModel(ms.defaultModel || '');
      // If no model selected yet, fall back to the default.
      setModel((cur) => cur || ms.defaultModel || '');
    } catch (e) {
      console.error('Failed to load model list:', e);
    }
  };

  useEffect(() => {
    const handler = () => { reload(); setOpen(true); };
    document.addEventListener('grammarSettingsRequested', handler);
    return () => document.removeEventListener('grammarSettingsRequested', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      if (!e.target.closest('.grammar-settings-dialog')) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.arcenApi.grammarLLMTestApi({ apiKey, model });
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e.message || String(e) });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await window.arcenApi.grammarLLMSaveSettings({ enabled, apiKey, model });
      setOpen(false);
    } catch (e) {
      console.error('Failed to save grammar LLM settings:', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 9998,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 80,
      }}
    >
      <div
        ref={dialogRef}
        className="grammar-settings-dialog"
        style={{
          background: 'var(--bg, #252526)',
          color: 'var(--text, #e0e0e0)',
          border: '1px solid var(--accent, #0e639c)',
          borderRadius: 4,
          padding: '14px 18px',
          minWidth: 460,
          maxWidth: 560,
          boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>Grammar Checker (LLM)</div>
        <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.5 }}>
          Sends localization strings to the Anthropic API for grammar checking.
          Results are cached per-project so re-runs only pay for changed text.
          The API key is stored in your user settings directory; it never leaves
          the main process. Required: an Anthropic API key (get one at console.anthropic.com).
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 4 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable grammar checking via the Anthropic API
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, opacity: 0.8 }}>API Key</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type={revealKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-…"
              spellCheck={false}
              style={{
                flex: 1,
                padding: '5px 8px',
                fontSize: 12,
                fontFamily: 'monospace',
                background: 'var(--sidebar-bg, #1e1e1e)',
                color: 'var(--text, #e0e0e0)',
                border: '1px solid var(--border, #444)',
                borderRadius: 2,
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => setRevealKey((v) => !v)}
              style={btnStyle()}
              title={revealKey ? 'Hide key' : 'Show key'}
            >
              {revealKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, opacity: 0.8 }}>Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              padding: '5px 8px',
              fontSize: 12,
              background: 'var(--sidebar-bg, #1e1e1e)',
              color: 'var(--text, #e0e0e0)',
              border: '1px solid var(--border, #444)',
              borderRadius: 2,
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onTest}
            disabled={testing || !apiKey || !model}
            style={btnStyle({ disabled: testing || !apiKey || !model })}
          >
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          {testResult && testResult.ok && (
            <span style={{ fontSize: 11, color: '#7ec97e', alignSelf: 'center' }}>
              ✓ Connected
            </span>
          )}
          {testResult && !testResult.ok && (
            <span style={{ fontSize: 11, color: '#ff8888', alignSelf: 'center' }}
                  title={testResult.error}>
              ✗ {testResult.error?.slice(0, 80) || 'Failed'}
            </span>
          )}
        </div>

        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--border, #444)',
        }}>
          <button type="button" onClick={() => setOpen(false)} style={btnStyle()}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={saving}
                  style={btnStyle({ primary: true, disabled: saving })}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function btnStyle({ primary = false, disabled = false } = {}) {
  return {
    padding: '5px 12px',
    fontSize: 11,
    background: primary ? 'var(--accent, #0e639c)' : 'var(--sidebar-bg, #1e1e1e)',
    color: primary ? '#fff' : 'var(--text, #e0e0e0)',
    border: '1px solid ' + (primary ? 'var(--accent, #0e639c)' : 'var(--border, #444)'),
    borderRadius: 3,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };
}
