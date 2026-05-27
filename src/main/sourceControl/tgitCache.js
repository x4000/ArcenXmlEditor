// TGitCache liveness probe. Mirrors tsvnCache.js.
//
// TortoiseGit ships a background process (TGitCache.exe) that watches the
// working tree and maintains a cached status result for the Explorer
// shell extension. When that cache is alive, our `git status` calls
// benefit from a warm `.git` index and run much faster. When it's not
// running we hide pips/dots entirely (same policy as the SVN provider —
// see Design.MD §28.5) rather than show stale or slow status.
//
// Primary signal: tasklist (is TGitCache.exe in the process list?).
// Fallback: named-pipe probe at \\.\pipe\TGitCacheCommand for restricted
// environments where tasklist may be unavailable.

const net = require('net');
const { spawn } = require('child_process');

// TortoiseGit's status pipe name; mirrors TortoiseSVN's \\.\pipe\TSVNCache.
const REQUEST_PIPE = '\\\\.\\pipe\\TGitCacheCommand';

let _aliveCache = null;
let _aliveCacheTime = 0;
const ALIVE_CACHE_TTL_MS = 15 * 1000;

// Async `tasklist` probe. The previous implementation used spawnSync, which
// blocks the entire main process for the duration of the tasklist call —
// and tasklist on Windows enumerates every running process, typically
// 500-2000 ms. That blocking propagated to the renderer through sync IPC
// (saveWindowState), showing up as a ~1 s cursor freeze every 30 s when
// runFullVcsRefresh invalidated the cache and forced a re-check. Using
// async spawn lets the Node event loop keep turning so other IPC requests
// are served while tasklist runs.
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
      proc = spawn('tasklist', ['/FI', 'IMAGENAME eq TGitCache.exe', '/NH', '/FO', 'CSV'], {
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
      finish(/\bTGitCache\.exe\b/i.test(stdout));
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
 * Whether TGitCache is alive. Resolves true/false; never rejects. Cached
 * for 15 s, same as the SVN equivalent.
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

  let alive = await isProcessRunning();
  if (!alive) {
    alive = await probePipe();
  }

  _aliveCache = alive;
  _aliveCacheTime = Date.now();
  return alive;
}

/**
 * Invalidate the liveness cache (e.g. after TortoiseGit settings change,
 * or when a TortoiseGitProc dialog exits).
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
