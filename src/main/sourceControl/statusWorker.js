// Worker thread for running a recursive SVN status query off the main
// process's event loop.
//
// Why this exists: on a large working copy, `svn status --xml` can produce
// hundreds of kilobytes of output, and the synchronous regex parse that
// follows blocks the main process for ~hundreds of ms. Moving the whole
// thing (subprocess + parse) into a Node worker_thread keeps the main
// process fully responsive to IPC, file-watcher events, and window focus
// while the repo-scope rollup is in flight.
//
// Protocol: parent posts once via workerData { svnExe, scopePath }. Worker
// does the status call + parse, posts back once:
//   { ok: true, map: Map<absPath, VcsStatus>, rollup }
//   { ok: false, error: string }
// Then exits. Caller is expected to spawn a fresh worker per request.

const { parentPort, workerData } = require('worker_threads');
const svnCli = require('./svnCli');

(async () => {
  try {
    const { svnExe, scopePath } = workerData || {};
    if (!svnExe || !scopePath) {
      parentPort.postMessage({ ok: false, error: 'Missing svnExe or scopePath' });
      return;
    }
    const { map, rollup } = await svnCli.getStatusRecursive(svnExe, scopePath);
    // Map is preserved by structured-clone so we can pass it across the
    // worker boundary without converting to an entries array.
    parentPort.postMessage({ ok: true, map, rollup });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
  }
})();
