import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { SYMBOL_MARK } from '../lib/core.js'

const ev = (type, seq, data = {}) => ({ type, seq, data })
const userMsg = (seq, text) =>
  ev('user/message', seq, { message: { role: 'user', content: [{ type: 'text', text }] } })
const call = (seq, name, args) =>
  ev('tool/call', seq, { turn: 1, step: 1, callId: 'c' + seq, name, arguments: JSON.stringify(args) })

const CHANGED = [
  userMsg(1, '把 worker 的资源关掉'),
  ev('turn/start', 2),
  call(3, 'edit', { file_path: 'src/worker.ts', old_string: 'open()', new_string: 'open()' }),
]

const finding = (severity = 'blocker') => ({
  rule: 'effect',
  severity,
  file: 'src/worker.ts',
  line: 3,
  symbol: 'open',
  why: '资源未释放',
  fix: '补 close',
})

function makeAgent(events) {
  return {
    session: { snapshotEvents: () => events },
    injected: [],
    steered: [],
    inject(text) {
      this.injected.push(text)
    },
    steer(text) {
      this.steered.push(text)
    },
  }
}

function makeCtx({ findings, failStart = false, stopReason = 'completed' } = {}) {
  const handlers = {}
  const calls = []
  const warns = []
  const subagents = {
    start: async (provider, request) => {
      calls.push({ provider, request })
      if (failStart) throw new Error('audit exploded')
      return {
        result: Promise.resolve({ stopReason, structured: { findings } }),
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    logger: { info() {}, warn: (message) => warns.push(String(message)) },
    on(name, handler) {
      handlers[name] = handler
    },
    get(name) {
      return name === 'subagents' ? subagents : undefined
    },
  }
  return { ctx, handlers, calls, warns }
}

const fire = (handlers, agent) => handlers['agent/turn-stopping']({ agent })

test('出现 blocker 时注入 findings 并 steer 主 agent', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers } = makeCtx({ findings: [finding('blocker')] })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 1)
  assert.ok(agent.injected[0].startsWith(SYMBOL_MARK))
  assert.ok(agent.injected[0].includes('src/worker.ts:3'))
  assert.equal(agent.steered.length, 1)
})

test('只有 minor 时不注入', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers } = makeCtx({ findings: [finding('minor')] })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
})

test('本轮没有改动时完全不调用审计器', async () => {
  const agent = makeAgent([userMsg(1, '只是聊聊'), ev('turn/start', 2)])
  const { ctx, handlers, calls } = makeCtx({ findings: [finding()] })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(calls.length, 0)
  assert.equal(agent.injected.length, 0)
})

test('审计请求强制只读并带结构化输出', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers, calls } = makeCtx({ findings: [] })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].request.toolFilter, { allow: [] })
  assert.equal(calls[0].request.outputSchema.type, 'object')
})

test('同一 turn 重复触发只审计一次', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers, calls } = makeCtx({ findings: [finding()] })
  apply(ctx)
  await fire(handlers, agent)
  await fire(handlers, agent)
  assert.equal(calls.length, 1)
})

test('没有 subagents seam 时放行并记一条 warn', async () => {
  const agent = makeAgent(CHANGED)
  const handlers = {}
  const warns = []
  const ctx = {
    logger: { info() {}, warn: (message) => warns.push(String(message)) },
    on(name, handler) {
      handlers[name] = handler
    },
    get() {
      return undefined
    },
  }
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
  assert.equal(warns.length, 1)
})

test('审计器启动失败时放行', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers } = makeCtx({ failStart: true })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
})

test('审计未完成时放行', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers } = makeCtx({ findings: [finding()], stopReason: 'aborted' })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
})

test('关闭开关后完全不介入', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers, calls } = makeCtx({ findings: [finding()] })
  apply(ctx, { enabled: false })
  await fire(handlers, agent)
  assert.equal(calls.length, 0)
  assert.equal(agent.injected.length, 0)
})

const styleFinding = {
  rule: 'style',
  severity: 'minor',
  file: 'src/worker.ts',
  line: 3,
  symbol: 'open',
  why: '绑定未使用',
  fix: '删除',
}

test('style 默认关闭:提示里没有风格清单', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers, calls } = makeCtx({ findings: [] })
  apply(ctx)
  await fire(handlers, agent)
  assert.ok(!calls[0].request.prompt[0].text.includes('未使用绑定'))
})

test('只有 style 发现时不注入', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers } = makeCtx({ findings: [styleFinding] })
  apply(ctx, { style: true })
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
})

test('style 开启且同时有 blocker 时,风格项单独成段', async () => {
  const agent = makeAgent(CHANGED)
  const { ctx, handlers, calls } = makeCtx({ findings: [finding('blocker'), styleFinding] })
  apply(ctx, { style: true })
  await fire(handlers, agent)
  assert.ok(calls[0].request.prompt[0].text.includes('未使用绑定'))
  assert.equal(agent.injected.length, 1)
  assert.ok(agent.injected[0].includes('风格(仅提示,不阻塞)'))
})
