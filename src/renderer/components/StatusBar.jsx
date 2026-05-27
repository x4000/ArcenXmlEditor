import React from 'react';
import PluginsChip from './PluginsChip';

export default function StatusBar({ theme, onToggleTheme, sidebarSide, onToggleSidebarSide, validationErrors, activeFile, onRevalidate, onChangeDataRoot, validationTimerDisplay, validationRunning }) {
  const errorCount = validationErrors.filter((e) => e.severity === 'error').length;
  const warnCount = validationErrors.filter((e) => e.severity === 'warning' && !e.message.startsWith('Spelling:') && !e.message.startsWith('Grammar (')).length;
  const spellingCount = validationErrors.filter((e) => e.message.startsWith('Spelling:')).length;
  const grammarCount = validationErrors.filter((e) => e.message.startsWith('Grammar (')).length;

  const hasIssues = errorCount > 0 || warnCount > 0 || spellingCount > 0 || grammarCount > 0;
  const statusClass = errorCount > 0
    ? 'status-bar has-errors'
    : warnCount > 0
      ? 'status-bar has-warnings'
      : (spellingCount > 0 || grammarCount > 0)
        ? 'status-bar has-info'
        : 'status-bar';

  // Build the counts display string
  const parts = [];
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`);
  if (warnCount > 0) parts.push(`${warnCount} warning${warnCount !== 1 ? 's' : ''}`);
  if (spellingCount > 0) parts.push(`${spellingCount} misspelling${spellingCount !== 1 ? 's' : ''}`);
  if (grammarCount > 0) parts.push(`${grammarCount} grammar`);

  return (
    <div className={statusClass}>
      <span style={{ flex: 1 }}>{activeFile || 'No file open'}</span>
      {validationTimerDisplay && (
        <span style={{ marginRight: 12, opacity: 0.8, fontSize: 11 }}>
          {validationRunning ? `Validating... ${validationTimerDisplay}` : validationTimerDisplay}
        </span>
      )}
      {hasIssues && (
        <span
          style={{ marginRight: 16, cursor: 'pointer' }}
          onClick={() => {
            window.arcenApi.openValidationWindow();
            setTimeout(() => {
              window.arcenApi.sendValidationResults(validationErrors);
              window.arcenApi.sendTheme(theme);
            }, 500);
          }}
          title="Click to open validation window"
        >
          {errorCount > 0 ? '\u26A0 ' : ''}{parts.join(' \u00b7 ')}
        </span>
      )}
      {!hasIssues && (
        <span
          style={{ marginRight: 16, opacity: 0.7, cursor: 'pointer' }}
          onClick={() => {
            window.arcenApi.openValidationWindow();
            setTimeout(() => {
              window.arcenApi.sendValidationResults(validationErrors);
              window.arcenApi.sendTheme(theme);
            }, 500);
          }}
          title="Click to open validation window"
        >{'\u2713'} No issues</span>
      )}
      <PluginsChip />
      <span
        style={{
          cursor: 'pointer', marginRight: 12, width: 16, height: 16,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.8)',
          fontSize: 10, fontWeight: 700, opacity: 0.8, verticalAlign: 'middle',
        }}
        onClick={() => window.arcenApi.openHelpWindow()}
        title="Open help reference"
      >
        ?
      </span>
      <span
        style={{ cursor: 'pointer', marginRight: 12, opacity: 0.8 }}
        onClick={onRevalidate}
        title="Re-validate all files"
      >
        ⟳
      </span>
      <img
        src="../../icons/folder-target.png"
        style={{ cursor: 'pointer', marginRight: 10, width: 16, height: 16, verticalAlign: 'middle', opacity: 0.9 }}
        onClick={(e) => onChangeDataRoot(e)}
        title="Change data folder"
      />
      <img
        src={theme === 'light' ? '../../icons/dark-mode.png' : '../../icons/light-mode.png'}
        style={{ cursor: 'pointer', marginRight: 10, width: 16, height: 16, verticalAlign: 'middle', opacity: 0.9 }}
        onClick={onToggleTheme}
        title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      />
      {onToggleSidebarSide && (
        <span
          style={{
            cursor: 'pointer', marginRight: 10, width: 16, height: 16,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            opacity: 0.9, verticalAlign: 'middle', fontSize: 16, lineHeight: 1,
          }}
          onClick={onToggleSidebarSide}
          title={sidebarSide === 'right' ? 'Move sidebar to left' : 'Move sidebar to right'}
        >
          {/* ◧ = filled-left square (sidebar currently on left), ◨ = filled-right.
              Show the OPPOSITE of current state so the icon previews the destination,
              matching the dark-mode toggle's "shows what you'll get" convention. */}
          {sidebarSide === 'right' ? '\u25E7' : '\u25E8'}
        </span>
      )}
    </div>
  );
}
