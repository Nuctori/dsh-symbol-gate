import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FINDINGS_SCHEMA,
  SYMBOL_MARK,
  auditPrompt,
  diffOf,
  extractTurnChanges,
  extractUserRequest,
  injectionOf,
  languageOf,
  normalizeFindings,
  parseArguments,
  verdictOf,
} from '../lib/core.js'

const ev = (type, seq, data = {}) => ({ type, seq, data })
const userMsg = (seq, text) =>
  ev('user/message', seq, { message: { role: 'user', content: [{ type: 'text', text }] } })
const call = (seq, name, args) =>
  ev('tool/call', seq, { turn: 1, step: 1, callId: 'c' + seq, name, arguments: JSON.stringify(args) })

test('parseArguments 只接受对象形态的 JSON', () => {
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 })
  assert.equal(parseArguments('not json'), null)
  assert.equal(parseArguments(null), null)
  assert.equal(parseArguments('[]'), null)
  assert.equal(parseArguments('"str"'), null)
})

test('diffOf 支持 edit 与 write,其余工具返回 null', () => {
  assert.deepEqual(diffOf('edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }), {
    added: 'y',
    removed: 'x',
  })
  assert.deepEqual(diffOf('write', { file_path: 'a.ts', content: 'z' }), {
    added: 'z',
    removed: null,
  })
  assert.equal(diffOf('read', { file_path: 'a.ts' }), null)
  assert.equal(diffOf('edit', { file_path: 'a.ts' }), null)
})

test('extractTurnChanges 只取本轮 edit/write,并保留文件顺序', () => {
  const events = [
    userMsg(1, '修一下 worker'),
    ev('turn/start', 2),
    call(3, 'edit', { file_path: 'src/worker.ts', old_string: 'a', new_string: 'b' }),
    call(4, 'read', { file_path: 'src/worker.ts' }),
    call(5, 'write', { file_path: 'src/util.ts', content: 'export const x = 1' }),
    call(6, 'edit', { file_path: 'src/worker.ts', old_string: 'c', new_string: 'd' }),
  ]
  const out = extractTurnChanges(events)
  assert.equal(out.changes.length, 3)
  assert.deepEqual(
    out.changes.map((change) => change.file),
    ['src/worker.ts', 'src/util.ts', 'src/worker.ts'],
  )
  assert.equal(out.truncated, false)
})

test('上一轮的改动不计入本轮', () => {
  const events = [
    ev('turn/start', 1),
    call(2, 'edit', { file_path: 'old.ts', old_string: 'a', new_string: 'b' }),
    userMsg(3, '再来一次'),
    ev('turn/start', 4),
    call(5, 'edit', { file_path: 'new.ts', old_string: 'a', new_string: 'b' }),
  ]
  const out = extractTurnChanges(events)
  assert.deepEqual(out.changes.map((change) => change.file), ['new.ts'])
})

test('无改动或参数非法时返回空', () => {
  assert.deepEqual(extractTurnChanges([]).changes, [])
  assert.deepEqual(extractTurnChanges([ev('turn/start', 1)]).changes, [])
  const events = [ev('turn/start', 1), call(2, 'edit', { file_path: 'a.ts' })]
  assert.deepEqual(extractTurnChanges(events).changes, [])
})

test('超出预算时截断并标记', () => {
  const events = [
    ev('turn/start', 1),
    call(2, 'write', { file_path: 'a.ts', content: 'x'.repeat(5000) }),
  ]
  const out = extractTurnChanges(events, { maxFileChars: 100, maxTotalChars: 1000 })
  assert.equal(out.truncated, true)
  assert.ok(out.changes[0].added.length <= 120)
})

test('extractUserRequest 跳过自身标记并取最近一条', () => {
  const events = [
    userMsg(1, '原始需求'),
    ev('turn/start', 2),
    userMsg(3, SYMBOL_MARK + ' 上次审计的注入'),
    ev('turn/start', 4),
  ]
  assert.equal(extractUserRequest(events), '原始需求')
  assert.equal(extractUserRequest([]), '')
})

test('languageOf 按扩展名归类', () => {
  assert.equal(languageOf('a.ts'), 'typescript')
  assert.equal(languageOf('a.tsx'), 'tsx')
  assert.equal(languageOf('a.mjs'), 'javascript')
  assert.equal(languageOf('a.py'), 'python')
  assert.equal(languageOf('README'), 'text')
})

test('审计提示包含 checklist 与全部改动', () => {
  const prompt = auditPrompt({
    userText: '修 worker',
    changes: [{ file: 'src/a.ts', tool: 'edit', added: 'const x = 1', removed: 'const x = 2' }],
  })
  assert.ok(prompt.includes('资源线性'))
  assert.ok(prompt.includes('效应'))
  assert.ok(prompt.includes('src/a.ts'))
  assert.ok(prompt.includes('const x = 1'))
  assert.ok(prompt.includes('修 worker'))
})

test('normalizeFindings 丢弃非法项、校验文件与理由并限量', () => {
  const out = normalizeFindings(
    {
      findings: [
        {
          rule: 'effect',
          severity: 'blocker',
          file: 'a.ts',
          line: 3,
          symbol: 'fetchUser',
          why: '未 await',
          fix: '加 await',
        },
        { rule: 'nope', severity: 'blocker', file: 'a.ts', line: 1, symbol: 'x', why: 'r', fix: 'f' },
        { severity: 'major', file: 'a.ts', line: 2, symbol: 'y', why: 'r', fix: 'f' },
        { rule: 'linearity', severity: 'minor', file: '', line: 4, symbol: 'f', why: 'r', fix: 'f' },
        { rule: 'linearity', severity: 'blocker', file: 'b.ts', line: 5, symbol: 'z', why: '  ', fix: 'f' },
      ],
    },
    2,
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].symbol, 'fetchUser')
  assert.deepEqual(normalizeFindings({ findings: 'x' }), [])
  assert.deepEqual(normalizeFindings(null), [])
})

test('verdictOf 只有 blocker/major 才拦', () => {
  assert.equal(verdictOf([]), false)
  assert.equal(verdictOf([{ severity: 'minor' }]), false)
  assert.equal(verdictOf([{ severity: 'major' }]), true)
  assert.equal(verdictOf([{ severity: 'blocker' }]), true)
})

test('injectionOf 带标记、文件行号与修法', () => {
  const text = injectionOf([
    {
      rule: 'effect',
      severity: 'blocker',
      file: 'src/a.ts',
      line: 3,
      symbol: 'fetchUser',
      why: '未 await',
      fix: '加 await',
    },
  ])
  assert.ok(text.startsWith(SYMBOL_MARK))
  assert.ok(text.includes('src/a.ts:3'))
  assert.ok(text.includes('加 await'))
})

test('输出 schema 强制 findings 数组', () => {
  assert.equal(FINDINGS_SCHEMA.type, 'object')
  assert.deepEqual(FINDINGS_SCHEMA.required, ['findings'])
})
