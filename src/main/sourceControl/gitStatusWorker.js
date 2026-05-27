// Worker thread for running a recursive git status query off the main
// process's event loop. Mirrors statusWorker.js but invokes gitCli
// instead of svnCli (different CLI, different parser).
//
// Why this exists: on a large working tree, `git status --porcelain` can
// produce a lot of output, and the synchronous post-processing blocks the
// main process. Moving the whole thing (subprocess + parse + abs-path
// resolution) into a Node worker_thread keeps the main process fully
// responsive to IPC, file-watcher events, and window focus while the
// repo-scope rollup is in flight.
//
// Protocol: parent posts once via workerData { gitExe, scopePath, repoRoot }.
// Worker does the status call + parse, posts back once:
//   { ok: true, map: Map<absPath, VcsStatus>, rollup }
//   { ok: false, error: string }
// Then exits. Caller is expected to spawn a fresh worker per request.

const { parentPort, workerData } = require('worker_threads');
const gitCli = require('./gitCli');

(async () => {
  try {
    const { gitExe, scopePath, repoRoot } = workerData || {};
    if (!gitExe || !scopePath || !repoRoot) {
      parentPort.postMessage({ ok: false, error: 'Missing gitExe, scopePath, or repoRoot' });
      return;
    }
    const { map, rollup } = await gitCli.getStatusRecursive(gitExe, scopePath, repoRoot);
    parentPort.postMessage({ ok: true, map, rollup });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
  }
})();
