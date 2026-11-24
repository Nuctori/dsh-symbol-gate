/**
 * dsh-symbol-gate — pure logic.
 *
 * Everything here is deterministic: read the session log, collect this turn's
 * edit/write calls as diffs, assemble one bounded audit prompt, and normalize
 * the judge's structured findings. No file IO, no shell, no dependencies.
 *
 * @module dsh-symbol-gate/core
 */

/** Marker prefixed to every injected audit message. */
export const SYMBOL_MARK = '[symbol-gate]'

/** Tools whose calls carry a code diff. */
export const DEFAULT_MUTATION_TOOLS = ['edit', 'write']

/** Per-file diff budget in characters. */
export const MAX_FILE_CHARS = 4000

/** Whole-prompt diff budget in characters. */
export const MAX_TOTAL_CHARS = 20000

/** Closed set of checklist rules the judge may report. */
export const FINDING_RULES = ['binding', 'linearity', 'effect', 'assertion', 'exhaustiveness', 'ordering']

/** Closed set of severities. */
export const FINDING_SEVERITIES = ['blocker', 'major', 'minor']

/** The structured output the auditor must satisfy. */
export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule', 'severity', 'file', 'line', 'symbol', 'why', 'fix'],
        properties: {
          rule: { type: 'string', enum: FINDING_RULES },
          severity: { type: 'string', enum: FINDING_SEVERITIES },
          file: { type: 'string' },
          line: { type: 'number' },
          symbol: { type: 'string' },
          why: { type: 'string', maxLength: 200 },
          fix: { type: 'string', maxLength: 200 },
        },
      },
    },
  },
}

/**
 * Read the session's event log through whichever face this host exposes.
 * @param {unknown} session
 * @returns {Array<object>}
 */
export function sessionEvents(session) {
  if (session === null || session === undefined || typeof session !== 'object') return []
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  if (Array.isArray(session.events)) return session.events
  return []
}

/**
 * Parse a tool call's raw argument string. Only object payloads are accepted.
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
export function parseArguments(raw) {
  if (typeof raw !== 'string') return null
  try {
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value
  } catch {
    return null
  }
}

/**
 * Turn one mutation tool call into a diff.
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @returns {{added: string, removed: string | null} | null}
 */
export function diffOf(tool, args) {
  if (tool === 'edit') {
    if (typeof args.new_string !== 'string') return null
    return {
      added: args.new_string,
      removed: typeof args.old_string === 'string' ? args.old_string : null,
    }
  }
  if (tool === 'write') {
    if (typeof args.content !== 'string') return null
    return { added: args.content, removed: null }
  }
  return null
}

/**
 * Collect this turn's code changes from the session log.
 * @param {Array<object>} events
 * @param {{mutationTools?: string[], maxFileChars?: number, maxTotalChars?: number}} [options]
 * @returns {{changes: Array<{file: string, tool: string, language: string, added: string, removed: string | null}>, truncated: boolean}}
 */
export function extractTurnChanges(events, options = {}) {
  const tools = options.mutationTools ?? DEFAULT_MUTATION_TOOLS
  const maxFileChars = options.maxFileChars ?? MAX_FILE_CHARS
  const maxTotalChars = options.maxTotalChars ?? MAX_TOTAL_CHARS
  if (!Array.isArray(events) || events.length === 0) return { changes: [], truncated: false }
  let turnStartIndex = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start') {
      turnStartIndex = i
      break
    }
  }
  const start = turnStartIndex >= 0 ? turnStartIndex + 1 : 0
  const changes = []
  let total = 0
  let truncated = false
  for (let i = start; i < events.length; i += 1) {
    const event = events[i]
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    if (typeof name !== 'string' || !tools.includes(name)) continue
    const args = parseArguments(event.data?.arguments)
    if (args === null) continue
    const file = args.file_path ?? args.path ?? args.file
    if (typeof file !== 'string' || file.length === 0) continue
    const diff = diffOf(name, args)
    if (diff === null) continue
    let added = diff.added ?? ''
    if (added.length > maxFileChars) {
      added = added.slice(0, maxFileChars) + '\n…'
      truncated = true
    }
    if (total + added.length > maxTotalChars) {
      truncated = true
      break
    }
    total += added.length
    changes.push({ file, tool: name, language: languageOf(file), added, removed: diff.removed })
  }
  return { changes, truncated }
}

/**
 * The latest human request in the session, skipping our own injections.
 * @param {Array<object>} events
 * @returns {string}
 */
export function extractUserRequest(events) {
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const text = textOf(event.data)
    if (text.length === 0) continue
    if (text.startsWith(SYMBOL_MARK)) continue
    return text
  }
  return ''
}

const LANGUAGES = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  swift: 'swift',
  php: 'php',
}

/**
 * Map a path to a language label.
 * @param {string} file
 * @returns {string}
 */
export function languageOf(file) {
  const name = String(file ?? '')
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'text'
  return LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? 'text'
}

/**
 * Build the single bounded audit prompt.
 * @param {{userText: string, changes: Array<{file: string, tool: string, language: string, added: string, removed: string | null}>}} input
 * @returns {string}
 */
export function auditPrompt({ userText, changes }) {
  const blocks = changes.map((change, index) => {
    const lines = [
      `### ${index + 1}. ${change.file} (${change.language}, ${change.tool})`,
      '新增/修改:',
      '```',
      change.added === '' ? '(空)' : change.added,
      '```',
    ]
    if (typeof change.removed === 'string' && change.removed.length > 0) {
      lines.push('被替换的旧内容:', '```', change.removed, '```')
    }
    return lines.join('\n')
  })
  return [
    '你是代码符号审计器。只审计下面的改动,不做风格或质量评价,也不要猜测未给出的文件内容。',
    '',
    'checklist(逐项判断,只报 FAIL):',
    '1. 绑定(binding):新增标识符是否有定义;引用是否指错符号;遮蔽是否导致误用。',
    '2. 资源线性(linearity):每个获取的资源(文件/连接/锁/迭代器)是否恰好释放一次;异常与提前返回路径是否泄漏;是否重复释放。',
    '3. 效应(effect):可能失败的操作是否被处理(await/.catch/try);catch 是否吞错;finally 是否覆盖异常;错误类型是否被丢弃。',
    '4. 断言诚实(assertion):as any / as unknown / ! / @ts-ignore 是否掩盖了不成立的假设。',
    '5. 穷尽(exhaustiveness):对联合类型的 switch/match 是否覆盖全部构造子。',
    '6. 顺序(ordering):校验是否先于副作用;部分失败是否留下半更新状态。',
    '',
    '输出要求:',
    '- 只报能从给定 diff 直接指认的缺陷;无法指认的不要报。',
    '- 最多 5 条。',
    '- 每条给 rule、severity(blocker|major|minor)、file(必须是上面出现过的路径)、line(改动内行号,未知填 -1)、symbol、why(一句)、fix(一句)。',
    '- 没有缺陷就返回空数组。',
    '',
    '用户本轮需求:',
    userText === '' ? '(未记录)' : truncate(userText, 600),
    '',
    '改动:',
    blocks.length === 0 ? '(无)' : blocks.join('\n\n'),
  ].join('\n')
}

/**
 * Per-agent set of turns already audited: a turn-stopping that fires more than
 * once for the same turn spends at most one audit call.
 */
export function createTurnBudget() {
  const seen = new WeakMap()
  const seenOf = (agent) => {
    let set = seen.get(agent)
    if (set === undefined) {
      set = new Set()
      seen.set(agent, set)
    }
    return set
  }
  return {
    used: (agent, turnId) => seenOf(agent).has(turnId),
    mark: (agent, turnId) => {
      seenOf(agent).add(turnId)
    },
  }
}

/**
 * Keep only well-formed findings; anything unexpected is dropped.
 * @param {unknown} structured
 * @param {number} [max]
 * @returns {Array<{rule: string, severity: string, file: string, line: number, symbol: string, why: string, fix: string}>}
 */
export function normalizeFindings(structured, max = 8) {
  const raw = structured === null || typeof structured !== 'object' ? undefined : structured.findings
  if (!Array.isArray(raw)) return []
  const findings = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    if (!FINDING_RULES.includes(item.rule)) continue
    if (!FINDING_SEVERITIES.includes(item.severity)) continue
    if (typeof item.file !== 'string' || item.file.trim().length === 0) continue
    const why = typeof item.why === 'string' ? item.why.trim() : ''
    if (why.length === 0) continue
    findings.push({
      rule: item.rule,
      severity: item.severity,
      file: item.file.trim(),
      line: Number.isFinite(item.line) ? item.line : -1,
      symbol: typeof item.symbol === 'string' ? item.symbol.trim() : '',
      why: truncate(why, 200),
      fix: truncate(typeof item.fix === 'string' ? item.fix.trim() : '', 200),
    })
    if (findings.length >= max) break
  }
  return findings
}

/**
 * Only blocker/major findings block; minor never flips the verdict.
 * @param {Array<{severity: string}>} findings
 * @returns {boolean}
 */
export function verdictOf(findings) {
  return findings.some((finding) => finding.severity === 'blocker' || finding.severity === 'major')
}

/**
 * The text injected back into the main agent.
 * @param {Array<{rule: string, severity: string, file: string, line: number, symbol: string, why: string, fix: string}>} findings
 * @returns {string}
 */
export function injectionOf(findings) {
  const lines = findings.map((finding, index) => {
    const symbol = finding.symbol === '' ? '' : finding.symbol + ' — '
    const fix = finding.fix === '' ? '' : ' | 修法: ' + finding.fix
    return `${index + 1}. [${finding.severity}] ${finding.file}:${finding.line} ${symbol}${finding.why}${fix}`
  })
  return [
    SYMBOL_MARK + ` 本轮改动有 ${findings.length} 处符号/效应问题:`,
    ...lines,
    '请先修这些再继续;若确认是误报,用一句话说明理由。',
  ].join('\n')
}

/** The steer hint sent alongside the injection. */
export function steerHint() {
  return '请先修复 symbol-gate 报出的符号/效应问题。'
}

function textOf(payload) {
  if (payload === null || typeof payload !== 'object') return ''
  const message = payload.message ?? payload
  const content = message?.content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }
  const direct = message?.text ?? payload.text
  return typeof direct === 'string' ? direct.trim() : ''
}

function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return value.slice(0, max) + '…'
}
