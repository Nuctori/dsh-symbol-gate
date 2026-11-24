/**
 * dsh-symbol-gate — the plugin row.
 *
 * Hangs on `agent/turn-stopping` only. Before a turn closes it collects that
 * turn's edit/write calls as diffs and asks one read-only subagent to audit
 * them against a fixed type-theory checklist. Blocker/major findings are
 * injected back and the main agent is steered to fix them; everything else —
 * including any judge failure — is a pass.
 *
 * @module dsh-symbol-gate
 */

import {
  DEFAULT_MUTATION_TOOLS,
  FINDINGS_SCHEMA,
  SYMBOL_MARK,
  auditPrompt,
  createTurnBudget,
  extractTurnChanges,
  extractUserRequest,
  injectionOf,
  normalizeFindings,
  sessionEvents,
  steerHint,
  verdictOf,
} from './core.js'

export const name = 'symbol-gate'

const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Subagent provider used by the read-only auditor. */
  provider: 'spawn',
  /** Agent preset, only needed on hosts that mount `startActivation`. */
  agentPreset: undefined,
  /** Audit time budget. */
  timeoutMs: 45_000,
  /** Per-file diff budget. */
  maxFileChars: 4000,
  /** Whole-prompt diff budget. */
  maxTotalChars: 20000,
  /** Findings kept per audit. */
  maxFindings: 5,
  /** Tools whose calls carry a diff. */
  mutationTools: DEFAULT_MUTATION_TOOLS,
  /** Steer the main agent to fix on blocker/major; false keeps it inject-only. */
  steer: true,
}

/**
 * @param {object} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const turnBudget = createTurnBudget()
  const logger = ctx.logger

  async function audit(userText, changes, agent, signal) {
    const subagents = ctx.get('subagents')
    if (subagents === undefined || subagents === null) {
      logger?.warn?.('dsh-symbol-gate: audit skipped: the subagents seam is not mounted')
      return null
    }
    const timeout = AbortSignal.timeout(cfg.timeoutMs)
    const signals = signal === undefined || signal === null ? [timeout] : [signal, timeout]
    const runSignal = AbortSignal.any(signals)
    const request = {
      label: 'symbol-gate',
      prompt: [{ type: 'text', text: auditPrompt({ userText, changes }) }],
      parent: agent,
      signal: runSignal,
      outputSchema: FINDINGS_SCHEMA,
      toolFilter: { allow: [] },
    }
    let run
    try {
      if (typeof subagents.start === 'function') {
        run = await subagents.start(cfg.provider, request)
      } else if (typeof subagents.startActivation === 'function' && cfg.agentPreset !== undefined) {
        run = await subagents.startActivation({
          ...request,
          provider: cfg.provider,
          agentPreset: cfg.agentPreset,
          delivery: 'caller',
        })
      } else {
        logger?.warn?.('dsh-symbol-gate: audit skipped: no compatible subagents seam')
        return null
      }
    } catch (error) {
      logger?.warn?.(`dsh-symbol-gate: audit start failed: ${String(error)}`)
      return null
    }
    try {
      const result = await run.result
      if (result?.stopReason !== 'completed') {
        logger?.warn?.(`dsh-symbol-gate: audit did not complete (${String(result?.stopReason)})`)
        return null
      }
      return result.structured ?? null
    } catch (error) {
      logger?.warn?.(`dsh-symbol-gate: audit failed: ${String(error)}`)
      return null
    } finally {
      try {
        await run.dispose?.()
      } catch {
        // An auditor that cannot be disposed must not break the turn.
      }
    }
  }

  function deliver(agent, text) {
    agent.inject(text)
    if (cfg.steer === true && typeof agent.steer === 'function') agent.steer(steerHint())
  }

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (cfg.enabled !== true || agent === undefined || agent === null) return
    try {
      const events = sessionEvents(agent.session)
      const turn = extractTurnChanges(events, {
        mutationTools: cfg.mutationTools,
        maxFileChars: cfg.maxFileChars,
        maxTotalChars: cfg.maxTotalChars,
      })
      if (turn.changes.length === 0) return
      const turnId = turnIdOf(events)
      if (turnBudget.used(agent, turnId)) return
      turnBudget.mark(agent, turnId)
      const userText = extractUserRequest(events)
      const structured = await audit(userText, turn.changes, agent, signal)
      const findings = normalizeFindings(structured, cfg.maxFindings)
      if (!verdictOf(findings)) return
      logger?.info?.(`dsh-symbol-gate: ${findings.length} finding(s) sent back`)
      deliver(agent, injectionOf(findings))
    } catch (error) {
      logger?.warn?.(`dsh-symbol-gate: gate skipped: ${String(error)}`)
    }
  })

  logger?.info?.('dsh-symbol-gate: installed (turn-stopping, read-only auditor)')
}

/** The current turn's identity: its `turn/start` seq, or -1 without one. */
function turnIdOf(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start') return events[i].seq ?? i
  }
  return -1
}
