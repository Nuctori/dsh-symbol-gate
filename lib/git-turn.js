import { execFile } from 'node:child_process'
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { languageOf } from './core.js'

const exec = promisify(execFile)
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const MAX_PATHS = 4000
const MAX_CHANGED = 64

function git(cwd, args, signal, maxBuffer) {
  // Ignore inherited repo/index overrides. All commands here are read-only.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  return exec('git', args, { cwd, signal, maxBuffer, env, encoding: 'buffer', windowsHide: true })
}

function bounded(parent, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

// A null snapshot is unavailable; an empty Map is a valid empty workspace.
async function snapshot(dir, signal, limit) {
  const cwd = await realpath(dir)
  const { stdout } = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal, 1024 * 1024)
  const names = new Set(utf8.decode(stdout).split('\0').filter(Boolean))
  if (names.size > MAX_PATHS) throw new Error('Git path budget exceeded')
  const files = new Map()
  let remaining = limit
  for (const name of names) {
    signal.throwIfAborted()
    const path = resolve(cwd, name)
    const rel = relative(cwd, path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escaped Git scope')
    try {
      const stat = await lstat(path)
      if (!stat.isFile()) continue
      if (await realpath(path) !== path) continue
      if (stat.size > remaining) throw new Error('Git snapshot budget exceeded')
      const fd = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(stat.size + 1)
        const { bytesRead } = await fd.read(buffer)
        if (bytesRead !== stat.size) throw new Error('File changed while taking Git snapshot')
        files.set(name, buffer.subarray(0, bytesRead))
        remaining -= bytesRead
      } finally {
        await fd.close()
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error
    }
  }
  signal.throwIfAborted()
  return { cwd, files }
}

async function diff(before, after, signal, { maxFileChars, maxTotalChars }) {
  const changes = []
  let total = 0, examined = 0
  const names = new Set([...before.files.keys(), ...after.files.keys()])
  let tmp
  try {
    for (const file of names) {
      signal.throwIfAborted()
      const old = before.files.get(file), current = after.files.get(file)
      if (old && current && old.equals(current)) continue
      if (++examined > MAX_CHANGED) throw new Error('Git changed-path budget exceeded')
      const empty = Buffer.alloc(0)
      if (old?.includes(0) || current?.includes(0)) continue
      try {
        utf8.decode(old ?? empty)
        utf8.decode(current ?? empty)
      } catch {
        continue // Only UTF-8 text can be sent to the reviewer.
      }
      tmp ??= await mkdtemp(join(tmpdir(), 'symbol-gate-diff-'))
      await writeFile(join(tmp, 'before'), old ?? empty, { signal })
      await writeFile(join(tmp, 'after'), current ?? empty, { signal })
      let patch
      try {
        const result = await git(tmp, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--text', '--unified=0', '--', 'before', 'after'], signal, 1024 * 1024)
        patch = result.stdout.toString('utf8')
      } catch (error) {
        if (error?.code !== 1 || error.killed) throw error
        patch = error.stdout.toString('utf8')
      }
      const hunks = patch.split(/\r?\n/).slice(4)
      const collect = prefix => hunks.filter(line => line.startsWith(prefix)).map(line => line.slice(1)).join('\n')
      const added = collect('+'), removed = collect('-')
      if (!hunks.some(line => line.startsWith('+') || line.startsWith('-'))) continue
      if (added.length + removed.length > maxFileChars || (total += added.length + removed.length + file.length) > maxTotalChars) {
        throw new Error('Git diff prompt budget exceeded')
      }
      changes.push({ file, tool: 'git diff', language: languageOf(file), added, removed })
    }
    return changes
  } finally {
    if (tmp) await rm(tmp, { force: true, recursive: true })
  }
}

export function createGitTurn(ctx, cfg) {
  const baselines = new WeakMap()
  const cwdOf = session => ctx.get('workingDirectory')?.get?.(session) ?? session?.header?.cwd
  return {
    async start(agent, id, signal) {
      const session = agent?.session
      if (!session || baselines.get(session)?.id === id) return
      const pending = (async () => {
        try {
          const cwd = cwdOf(session)
          return typeof cwd === 'string' && isAbsolute(cwd)
            ? await snapshot(cwd, bounded(signal, cfg.gitTimeoutMs), cfg.gitMaxBytes) : null
        } catch {
          return null
        }
      })()
      baselines.set(session, { id, pending })
      await pending
    },
    async changes(agent, id, signal) {
      const session = agent?.session
      const saved = session && baselines.get(session)
      if (!saved || saved.id !== id) return null
      try {
        const before = await saved.pending
        if (!before) return null
        const control = bounded(signal, cfg.gitTimeoutMs)
        const cwd = cwdOf(session)
        if (typeof cwd !== 'string' || !isAbsolute(cwd) || await realpath(cwd) !== before.cwd) return null
        const after = await snapshot(cwd, control, cfg.gitMaxBytes)
        return await diff(before, after, control, cfg)
      } catch {
        return null
      }
    },
  }
}
