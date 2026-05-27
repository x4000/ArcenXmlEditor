// Launch TortoiseProc dialogs. The renderer calls a generic command ID
// (commit, update, revert, log, diff, blame, resolveConflict,
// checkModifications); this module maps it to the TortoiseProc /command
// string and spawns the process.
//
// TortoiseProc returns quickly after showing the dialog; the dialog itself
// persists until the user closes it. Our Promise resolves on the child
// process exit, which happens when the dialog closes. Callers can use that
// signal to trigger a status refresh.

const { spawn } = require('child_process');

// Generic command ID → TortoiseProc /command name.
const COMMAND_MAP = {
  commit: 'commit',
  update: 'update',
  revert: 'revert',
  log: 'log',
  diff: 'diff',
  blame: 'blame',
  resolveConflict: 'conflicteditor',
  checkModifications: 'repostatus',
};

/**
 * Labels used by the SVN provider when building context menus.
 */
const COMMAND_LABELS = {
  commit: 'SVN Commit…',
  update: 'SVN Update',
  revert: 'SVN Revert…',
  log: 'SVN Show Log',
  diff: 'SVN Diff',
  blame: 'SVN Blame…',
  resolveConflict: 'Edit Conflicts…',
  checkModifications: 'SVN Check for Modifications',
};

function getCommandLabel(id) {
  return COMMAND_LABELS[id] || id;
}

/**
 * Run a TortoiseProc dialog. `tortoiseProcExe` is the absolute path to
 * TortoiseProc.exe (obtained via toolDiscovery.findTortoiseProcExe()).
 *
 * Returns a Promise<number> that resolves to the process exit code. Never
 * rejects.
 *
 * opts:
 *   path: absolute path operand for /path (required for most commands)
 *   closeOnEnd: 0–4 — TortoiseProc's "close dialog on end" behavior.
 *               Default 0 (leave dialog open so user sees result).
 */
function runTortoise(tortoiseProcExe, commandId, opts = {}) {
  return new Promise((resolve) => {
    if (!tortoiseProcExe) return resolve(-1);
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
      proc = spawn(tortoiseProcExe, args, {
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
  runTortoise,
  getCommandLabel,
  COMMAND_MAP,
  COMMAND_LABELS,
};
