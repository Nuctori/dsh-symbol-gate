import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function fixture(t, repo = true, config = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'symbol-gate-test-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd })
  const write = (name, value) => writeFileSync(join(cwd, name), value)
  const shell = script => process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/c', script], { cwd })
    : execFileSync('sh', ['-c', script], { cwd })
  if (repo) {
    git('init', '-q')
    write('dirty.js', 'staged value\n')
    write('reverted.js', 'original\n')
    write('old.js', 'staged deletion\n')
    write('.gitignore', 'ignored.js\n')
    git('add', '.')
    write('dirty.js', 'old pre-existing change\n')
    write('untouched.js', 'existing untracked\n')
  }
  const handlers = new Map(), prompts = []
  const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }]
  const agent = { session: { header: { cwd }, snapshotEvents: () => events } }
  apply({ on: (name, handler) => handlers.set(name, handler), get: (name) => name === 'subagents' ? {
    async start(_provider, request) {
      prompts.push(request.prompt[0].text)
      return { result: { stopReason: 'completed', structured: { findings: [] } } }
    },
  } : undefined }, config)
  const start = async () => {
    const next = () => ({ kind: 'continue' })
    const hook = handlers.get('agent/pre-step')
    if (hook) assert.deepEqual(await hook({ agent, turn: 1, step: 1 }, next), next())
  }
  const stop = signal => handlers.get('agent/turn-stopping')({ agent, turn: 1, signal })
  const call = (file_path, content) => events.push({ type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path, content }) } })
  return { cwd, git, write, shell, start, stop, call, prompts }
}

test('Git 基线只审本轮净变化，覆盖 Shell、暂存与同轮工具混用且不写真实 index', async t => {
  const f = fixture(t)
  const indexPath = join(f.cwd, '.git', 'index')
  await f.start()
  f.call('reverted.js', 'transient tool payload')
  f.shell('echo new shell change>dirty.js')
  f.shell('echo new untracked file>new.js')
  f.write('ignored.js', 'not audit material\n')
  rmSync(join(f.cwd, 'old.js'))
  f.git('add', '-u')
  const indexBeforeStop = readFileSync(indexPath)
  await f.stop()
  assert.equal(f.prompts.length, 1)
  assert.match(f.prompts[0], /new shell change/)
  assert.match(f.prompts[0], /old pre-existing change/)
  assert.match(f.prompts[0], /new untracked file/)
  assert.match(f.prompts[0], /staged deletion/)
  assert.doesNotMatch(f.prompts[0], /existing untracked|staged value|transient tool payload|ignored\.js/)
  assert.deepEqual(readFileSync(indexPath), indexBeforeStop)
})

test('Git 净变化为空时不审已撤销的工具改动', async t => {
  const f = fixture(t)
  await f.start()
  f.call('reverted.js', 'transient tool payload')
  await f.stop()
  await f.stop()
  assert.equal(f.prompts.length, 0)
})

test('Git 采集中取消后，同回合重试仍能审到仅 Shell 写入的变化', async t => {
  const f = fixture(t)
  await f.start()
  f.shell('echo shell-only retry evidence>new.js')
  const controller = new AbortController()
  const stopped = f.stop(controller.signal)
  controller.abort()
  await stopped
  assert.equal(f.prompts.length, 0)
  await Promise.all([f.stop(), f.stop()])
  assert.equal(f.prompts.length, 1)
  assert.match(f.prompts[0], /shell-only retry evidence/)
})

for (const mode of ['non-repo', 'missing-baseline', 'budget']) {
  test(`Git 不可用时保留工具采集：${mode}`, async t => {
    const f = fixture(t, mode !== 'non-repo', mode === 'budget' ? { gitMaxBytes: 1 } : {})
    if (mode !== 'missing-baseline') await f.start()
    f.call('fallback.js', 'fallback tool payload')
    await f.stop()
    assert.equal(f.prompts.length, 1)
    assert.match(f.prompts[0], /fallback tool payload/)
  })
}
