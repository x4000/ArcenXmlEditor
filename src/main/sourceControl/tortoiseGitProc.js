// Launch TortoiseGitProc dialogs. The renderer calls a generic command ID
// (commit, pull, push, …); this module maps it to the TortoiseGitProc
// /command name and spawns the process.
//
// TortoiseGitProc returns quickly after showing the dialog; the dialog
// itself persists until the user closes it. Our Promise resolves on the
// child process exit, which happens when the dialog closes — callers can
// use that signal to trigger a status refresh.

const { spawn } = require('child_process');

// Generic command ID → TortoiseGitProc /command name.
const COMMAND_MAP = {
  commit: 'commit',
  pull: 'pull',
  push: 'push',
  fetch: 'fetch',
  sync: 'sync',
  log: 'log',
  diff: 'diff',
  blame: 'blame',
  revert: 'revert',
  rebase: 'rebase',
  switch: 'switch',
  merge: 'merge',
  resolveConflict: 'resolve',
  checkModifications: 'repostatus',
};

/**
 * Labels used by the Git provider when building context menus. The "…" is
 * added on commands that open a parameterized dialog the user must
 * confirm; commands that act immediately or only show information get no
 * ellipsis. Matches the SVN provider's wording style.
 */
const COMMAND_LABELS = {
  commit:             'Git Commit…',
  pull:               'Git Pull…',
  push:               'Git Push…',
  fetch:              'Git Fetch…',
  sync:               'Git Sync…',
  log:                'Git Show Log',
  diff:               'Git Diff',
  blame:              'Git Blame…',
  revert:             'Git Revert…',
  rebase:             'Git Rebase…',
  switch:             'Git Switch/Checkout…',
  merge:              'Git Merge…',
  resolveConflict:    'Edit Conflicts…',
  checkModifications: 'Git Check for Modifications',
};

function getCommandLabel(id) {
  return COMMAND_LABELS[id] || id;
}

/**
 * Run a TortoiseGitProc dialog. `tortoiseGitProcExe` is the absolute path
 * to TortoiseGitProc.exe (obtained via toolDiscovery.findTortoiseGitProcExe()).
 *
 * Returns a Promise<number> that resolves to the process exit code. Never
 * rejects.
 *
 * opts:
 *   path: absolute path operand for /path (required for most commands)
 *   closeOnEnd: 0–4 — TortoiseGitProc's "close dialog on end" behavior.
 *               Default 0 (leave dialog open so user sees result).
 */
function runTortoiseGit(tortoiseGitProcExe, commandId, opts = {}) {
  return new Promise((resolve) => {
    if (!tortoiseGitProcExe) return resolve(-1);
    const tortoiseCmd = COMMAND_MAP[commandId];
    if (!tortoiseCmd) return resolve(-2);

    const args = [`/command:${tortoiseCmd}`];
    if (opts.path) args.push(`/path:${opts.path}`);
    args.push(`/closeonend:${opts.closeOnEnd != null ? opts.closeOnEnd : 0}`);
    if (opts.extraArgs) {
      for (const [k, v] of Object.entries(opts.extraArgs)) {
        args.push(v === true ? `/${k}` : `/${k}:${v}`);
      }
    }

    let proc;
    try {
      proc = spawn(tortoiseGitProcExe, args, {
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      });
    } catch (e) {
      return resolve(-1);
    }

    proc.on('exit', (code) => resolve(code != null ? code : 0));
    proc.on('error', () => resolve(-1));
    // Don't unref — we want to await the exit to trigger status refresh.
  });
}

module.exports = {
  runTortoiseGit,
  getCommandLabel,
  COMMAND_MAP,
  COMMAND_LABELS,
};
