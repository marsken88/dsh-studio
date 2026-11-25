// 从 dsh 的会话日志里读用量：<home>/.dsh/sessions/<ws>/studio-<taskId>-<expert>/session.v4.jsonl.zstd
// 用 zstd 解压（宿主上本来就有），按 mtime 缓存，避免每刷新一次效能页都重解一遍。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSubscriptionModel, parseUsageLines, priceOf as priceOfModel, summarizeUsage } from './usage.js'

const run = promisify(execFile)
const CACHE = new Map()

export function sessionsRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

/**
 * studio-<taskId>-<expertId>：taskId 形如 t-01a3c8d3，剩下都算专家。
 * 无卡会话 `studio-chat-<expert>-<hex>` 也解析：taskId 为空 + adHoc 标记，
 * 用量算进总量与按专家，但不冒充某张卡的消耗（issue #148）。
 */
export function parseSessionName(name) {
  const text = String(name ?? '')
  const chat = /^studio-chat-(.+?)-[0-9a-f]{6,}$/.exec(text)
  if (chat !== null) return { taskId: '', expert: chat[1], adHoc: true }
  const match = /^studio-(t-[a-z0-9]+)-(.+)$/.exec(text)
  if (match === null) return null
  return { taskId: match[1], expert: match[2] }
}

async function readFileUsage(file) {
  let mtimeMs = 0
  try { mtimeMs = (await stat(file)).mtimeMs } catch { return null }
  const cached = CACHE.get(file)
  // 缓存命中也要带上 at：漏了它，界面上的「最近一次会话」会显示成 —
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return { ...cached, at: cached.mtimeMs }
  let usage = []
  let counts = { turns: 0, toolCalls: 0, retries: 0, contextWindow: 0, model: '' }
  const volume = { user: 0, assistant: 0, tool: 0, other: 0 }
  try {
    const { stdout } = await run('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 })
    const lines = stdout.split('\n')
    usage = parseUsageLines(lines)
    // 顺手数一下回合/工具/重试：上下文洞察要用，不额外解压一遍
    for (const line of lines) {
      if (line.includes('"type":"step/start"')) counts.turns += 1
      else if (line.includes('"type":"tool-call"')) counts.toolCalls += 1
      else if (line.includes('"type":"llm/retry"')) counts.retries += 1
      // request/context 里有引擎真实的上下文窗口（实测 1,000,000）：占用率要用它算，不能猜
      else if (line.includes('"type":"request/context"')) {
        try {
          const parsed = JSON.parse(line)?.data ?? {}
          if (Number(parsed.contextWindow) > 0) { counts.contextWindow = Number(parsed.contextWindow); if (parsed.model) counts.model = String(parsed.model) }
        } catch { /* 半行/坏行忽略 */ }
      }
      // 上下文构成按「日志里各类事件的文本体积」估算：宿主不暴露真实 token 分配，这是能拿到的最好近似
      const kind = /"type":"([a-z-]+)\/?([a-z-]*)"/.exec(line)
      if (kind !== null) {
        const name = kind[1] + (kind[2] === '' ? '' : '/' + kind[2])
        if (name.startsWith('tool')) volume.tool += line.length
        else if (name.startsWith('assistant')) volume.assistant += line.length
        else if (name.startsWith('user') || name.startsWith('inbox')) volume.user += line.length
        else volume.other += line.length
      }
    }
  } catch {
    // 没装 zstd 或者文件坏了：当作读不到，不抛，页面上显示未知
    usage = []
  }
  CACHE.set(file, { mtimeMs, usage, counts, volume })
  return { usage, counts, volume, at: mtimeMs }
}

/** 扫一遍所有 studio-* 会话，返回 [{ taskId, expert, at, usage }]。 */
export async function collectSessionUsage(root = sessionsRoot()) {
  const out = []
  let workspaces = []
  try { workspaces = await readdir(root) } catch { return out }
  for (const workspace of workspaces) {
    const dir = join(root, workspace)
    let entries = []
    try { entries = await readdir(dir) } catch { continue }
    for (const entry of entries) {
      const parsed = parseSessionName(entry)
      if (parsed === null) continue
      const read = await readFileUsage(join(dir, entry, 'session.v4.jsonl.zstd'))
      if (read === null || read.usage.length === 0) continue
      out.push({ taskId: parsed.taskId, expert: parsed.expert, adHoc: parsed.adHoc === true, at: read.at, usage: read.usage, counts: read.counts, volume: read.volume })
    }
  }
  return out
}

/** 按卡 / 按专家汇总 token 与钱；prices 来自 config.costs.prices。 */
export function aggregateUsage(sessions, tasks, prices, costOf, priceOf) {
  const unpriced = new Map()
  const byCard = new Map()
  const byExpert = new Map()
  const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  // 会话（无卡）的消耗也要进总量：它不计入任何一张卡，但不能凭空消失。
  let costSum = 0
  let unknownSum = 0
  for (const session of sessions) {
    const summary = summarizeUsage(session.usage)
    const money = costOf(prices, session.usage)
    // 哪些模型还没配价目：直接告诉用户要补哪几行，比只说「719 次未知」有用
    for (const item of session.usage) {
      const model = String(item.model ?? '(未记录模型)')
      if (priceOfModel(prices, item.model) !== null) continue
      if (isSubscriptionModel(item.model)) continue
      unpriced.set(model, (unpriced.get(model) ?? 0) + 1)
    }
    for (const key of ['calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'total']) totals[key] += summary[key]
    if (money.cost !== null) costSum += money.cost
    unknownSum += money.unknownCalls
    // 无卡会话（studio-chat-*）没有所属卡：只进总量与按专家，不冒充某张卡的消耗。
    if (session.adHoc !== true) {
      const card = byCard.get(session.taskId) ?? { taskId: session.taskId, ...{ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, unknownCalls: 0 }
      for (const key of ['calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'total']) card[key] += summary[key]
      if (money.cost !== null) card.cost += money.cost
      card.unknownCalls += money.unknownCalls
      byCard.set(session.taskId, card)
    }
    const expert = byExpert.get(session.expert) ?? { expert: session.expert, calls: 0, total: 0, cost: 0, unknownCalls: 0 }
    expert.calls += summary.calls
    expert.total += summary.total
    if (money.cost !== null) expert.cost += money.cost
    expert.unknownCalls += money.unknownCalls
    byExpert.set(session.expert, expert)
  }
  const taskOf = new Map((Array.isArray(tasks) ? tasks : []).map((task) => [String(task.id ?? ''), task]))
  const cards = [...byCard.values()].map((card) => {
    const task = taskOf.get(card.taskId)
    return { ...card, code: String(task?.code ?? ''), title: String(task?.title ?? ''), project: String(task?.project ?? '') }
  }).sort((a, b) => b.total - a.total)
  const round = (value) => Math.round(value * 10000) / 10000
  return {
    totals: {
      ...totals,
      // 有算不出价的调用且一分钱都没算出来时，给 null（未知），不要报成 0
      cost: unknownSum > 0 && costSum === 0 ? null : round(costSum),
      unknownCalls: unknownSum,
    },
    cards: cards.slice(0, 50),
    unpricedModels: [...unpriced.entries()].map(([model, calls]) => ({ model, calls })).sort((a, b) => b.calls - a.calls).slice(0, 10),
    experts: [...byExpert.values()].map((row) => ({ ...row, cost: round(row.cost) })).sort((a, b) => b.total - a.total),
  }
}
