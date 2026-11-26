export function makeTempDir(prefix: string, base?: string): string
export function removeTempDir(dir: string): void
export function withTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<Awaited<T>>
export function withTempDirSync<T>(prefix: string, fn: (dir: string) => T): T
export function sandboxEnv(dir: string): Record<string, string>
