/**
 * Run a child process WITHOUT blocking the calling event loop.
 *
 * Test files must use this instead of spawnSync/execFileSync for anything that can take seconds.
 * A vitest worker talks to the host over an RPC that times out after 60 s (`Timeout calling
 * "onTaskUpdate"`); a worker parked in spawnSync cannot read the host's reply, and when the child runs
 * long (a build on a loaded 4-vCPU runner) the timer fires before the already-delivered reply is read.
 * Same result shape as spawnSync's: { status, signal, stdout, stderr, error }.
 */
import { spawn } from 'node:child_process'

export function spawnAsync(command, args = [], { timeout, encoding = 'utf8', ...options } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options)
    const out = []
    const err = []
    let error
    let timer
    if (timeout) timer = setTimeout(() => { error = Object.assign(new Error(`spawnAsync ${command} ETIMEDOUT`), { code: 'ETIMEDOUT' }); child.kill('SIGTERM') }, timeout)
    child.stdout?.on('data', (d) => out.push(d))
    child.stderr?.on('data', (d) => err.push(d))
    child.on('error', (e) => { error = e })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout: Buffer.concat(out).toString(encoding), stderr: Buffer.concat(err).toString(encoding), error })
    })
  })
}
