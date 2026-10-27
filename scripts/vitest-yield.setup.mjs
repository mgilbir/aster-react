/**
 * Let the worker's event loop turn between tests.
 *
 * A vitest worker reports to the host over an RPC with a 60 s timeout (`Timeout calling "onTaskUpdate"`).
 * The timeout is a timer inside the worker. A test file made of synchronous tests (the corpus-wide parity
 * and oracle suites) runs its tests back to back on microtasks alone, so for the whole file the worker
 * neither sends its pending reports nor reads the host's replies. On a loaded 4-vCPU runner such a file
 * takes more than a minute, and when it ends the expired timer fires before the reply is read: the run
 * reports an unhandled error and exits non-zero although every test passed.
 *
 * One macrotask turn after each test bounds the stall to the longest single test, at no measurable cost.
 * (Test code that spawns long children must not use spawnSync either: scripts/lib/spawn-async.mjs.)
 */
import { afterEach } from 'vitest'

afterEach(() => new Promise((resolve) => setImmediate(resolve)))
