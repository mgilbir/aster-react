// The engine-sharing guard's own fixtures (scripts/engine-sharing.test.mjs runs them): the root config, these files only.
import { fileURLToPath } from 'node:url'
import base from '../../../../vitest.config.mjs'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
export default { ...base, root, test: { ...base.test, include: ['packages/conformance/test-fixtures/engine-sharing/*.fixture.ts'] } }
