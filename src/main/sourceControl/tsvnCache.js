// TSVNCache liveness probe.
//
// TortoiseSVN ships a background process (TSVNCache.exe) that maintains a
// live recursive status tree. The "canonical" liveness check in the TSVN
// Explorer shell extension is to connect to its named pipe
// (\\.\pipe\TSVNCache), but connection-state detection via Node's net
// module has turned out to be flaky on some systems (pipe may accept the
// connection then drop it before the `connect` event fires, or may return
// EPIPE for reasons unrelated to "cache disabled"). Since our simplified
// implementation reads status via `svn status --xml` rather than the pipe
// protocol, we only need to know whether TSVNCache.exe is *running* — the
// cache then feeds svn.exe's status queries on disk, making them fast.
//
// So: primary check is tasklist (is TSVNCache.exe in the process list?).
// The pipe probe remains as a secondary signal in case tasklist is
// unavailable (restricted environments, etc.).
//
// This is an intentional simplification over the full pipe protocol
// described in §7 of SvnDesign.MD. Migrating to the binary protocol later
// will not require changes in any caller of isCacheAlive().

const net = require('net');
const { spawn } = require('child_process');

const REQUEST_PIPE = '\\\\.\\pipe\\TSVNCache';

let _aliveCache = null;
let _aliveCacheTime = 0;
const ALIVE_CACHE_TTL_MS = 15 * 1000; // 15s

// Async `tasklist` probe. See the long comment in tgitCache.js — the
// previous spawnSync version blocked the main process for 0.5-2 s per
// call, which translated to renderer-side cursor freezes whenever a sync
// IPC landed during that window. Using async spawn keeps the event loop
// available so IPC stays responsive while tasklist runs.
function isProcessRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      resolve(alive);
    };
    let proc;
    try {
      proc = spawn('tasklist', ['/FI', 'IMAGENAME eq TSVNCache.exe', '/NH', '/FO', 'CSV'], {
        windowsHide: true,
      });
    } catch (_) {
      return finish(false);
    }
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      finish(false);
    }, 3000);
    proc.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(false);
      // When found, output is like: "TSVNCache.exe","12345","Console","1","8,432 K"
      // When not found, output is: "INFO: No tasks are running..."
      finish(/\bTSVNCache\.exe\b/i.test(stdout));
    });
    proc.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

function probePipe() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) { /* ignore */ }
      resolve(!!alive);
    };
    const socket = net.createConnection({ path: REQUEST_PIPE });
    const timer = setTimeout(() => finish(false), 800);
    socket.once('connect', () => { clearTimeout(timer); finish(true); });
    socket.once('error', () => { clearTimeout(timer); finish(false); });
  });
}

/**
 * Whether TSVNCache is alive. Resolves true/false; never rejects. Cached.
 */
async function isCacheAlive() {
  if (_aliveCache !== null && (Date.now() - _aliveCacheTime) < ALIVE_CACHE_TTL_MS) {
    return _aliveCache;
  }
  if (process.platform !== 'win32') {
    _aliveCache = false;
    _aliveCacheTime = Date.now();
    return false;
  }

  // Primary: is the process running?
  let alive = await isProcessRunning();

  // Fallback: pipe probe (for restricted envs where tasklist is blocked).
  if (!alive) {
    alive = await probePipe();
  }

  _aliveCache = alive;
  _aliveCacheTime = Date.now();
  return alive;
}

/**
 * Invalidate the liveness cache (e.g. after TortoiseSVN settings change,
 * or when a TortoiseProc dialog exits).
 */
function invalidate() {
  _aliveCache = null;
  _aliveCacheTime = 0;
}

module.exports = {
  isCacheAlive,
  invalidate,
  REQUEST_PIPE,
};
