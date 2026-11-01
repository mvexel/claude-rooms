import { Worker } from 'node:worker_threads'

// A hub call is synchronous, so nothing on the main thread can interrupt it.
// A worker thread has its own timers: when the budget runs out it ends this
// process, so a plugin hook returns before the plugin's own timeout.
export function watchdog(ms: number, what: string): void {
  const w = new Worker(
    `const { workerData: d } = require('node:worker_threads');
     setTimeout(() => { process.stderr.write('rooms: ' + d.what + ' took longer than ' + d.ms + ' ms, giving up\\n'); process.kill(d.pid, 'SIGKILL') }, d.ms)`,
    { eval: true, workerData: { ms, what, pid: process.pid } },
  )
  w.unref()
}
