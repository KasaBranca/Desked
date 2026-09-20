/**
 * Watch the parent process so orphaned servers/tunnels do not linger after the
 * launcher (terminal, CLI) exits.
 *
 * Signals are not enough on Windows: closing a terminal or hard-killing the
 * parent does not reliably deliver SIGTERM to children. Polling the parent PID
 * with signal 0 works even when the parent is terminated abruptly.
 */
'use strict';

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // On Windows (and Unix) EPERM means the process exists but we cannot signal
    // it; anything else (ESRCH) means it is gone.
    return Boolean(err) && err.code === 'EPERM';
  }
}

/**
 * Invoke onExit once the parent process disappears. Returns the interval
 * handle (unref'd so it never keeps the event loop alive on its own).
 */
function watchParent(onExit, { intervalMs = 3000, pid, unref = true } = {}) {
  const ppid = pid || process.ppid;
  if (!ppid || ppid === process.pid) return null;

  const timer = setInterval(() => {
    if (isProcessAlive(ppid)) return;
    clearInterval(timer);
    onExit();
  }, intervalMs);
  if (unref && typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { watchParent, isProcessAlive };
