// 文档出口配置的写入层：保存 /config 的 docs 时先校验、再交给 index.js 落库。
//
// 为什么单独一个模块（REQ-2026-003 p3 方案定案）：
//   · 校验规则不少（形状/枚举/容量/保存后生效范围），内联在 index.js 会把行数棘轮顶爆
//     （index.js 只剩 5 行余量）；内联在路由里则拿不到 store.mutate 的同一份快照，会产生 TOCTOU。
//   · 纯函数好被单测直接打（tests/docs-config.test.mjs），且 applyConfig 的其它调用方也走同一套规则。
//
// 两条语义（方案 §5.1）：
//   · perProject 是「整表替换」：patch 里没有的项目 = 取消覆盖；patch 不带字段 = 保留现状。
//   · weknora 是「字段级合并」：只发 baseUrl 不冲掉 tenantId/kb；apiKey 留空 = 不修改。
//
// 保存失败抛 DocsConfigError（code=docs_config_invalid / docs_config_not_ready），
// 由 src/host/routes/admin.js 映射成 400 结构化体；状态在 store.mutate 里回滚，落库 0 项。
import { DOC_PROVIDERS, sanitizeDocsConfig } from './doc-sink.js'
import { weknoraReady } from './weknora-sink.js'

/* 与 sanitizeWeKnoraSink 的截断上限保持一致（R10：超长是错误，不静默截断）。 */
const SINK_LIMITS = { baseUrl: 300, apiKey: 200, tenantId: 40, knowledgeBaseId: 60 }
const MAX_PER_PROJECT = 200
const MAX_PROJECT_ID = 60
const DOC_FIELDS = ['provider', 'perProject', 'weknora']

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 归一：只认字符串（数组/对象/boxed string 都不算），trim + lower 后必须落在枚举里。 */
const pickProvider = value => {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().toLowerCase()
  return DOC_PROVIDERS.includes(normalized) ? normalized : ''
}

/** 400 的载荷：invalid 是「哪个键错、错了什么值、为什么」，缺失/影响范围只给 not_ready。 */
export class DocsConfigError extends Error {
  constructor(message, { code = 'docs_config_invalid', invalid = [], missing = [], scopes = [] } = {}) {
    super(message)
    this.name = 'DocsConfigError'
    this.code = code
    this.invalid = invalid
    this.missing = missing
    this.scopes = scopes
  }
}

/** provider / perProject 值：形状错与枚举错要分开报，面板才知道是改类型还是改值。 */
function readProvider(value, key, invalid) {
  if (typeof value !== 'string') {
    invalid.push({ key, value, reason: 'not-string' })
    return ''
  }
  const picked = pickProvider(value)
  if (picked === '') invalid.push({ key, value, reason: 'unknown-provider' })
  return picked
}

function readPerProject(input, invalid) {
  if (!isPlainObject(input)) {
    invalid.push({ key: 'perProject', value: input, reason: 'not-object' })
    return undefined
  }
  const table = {}
  const seen = new Set()
  for (const [rawKey, value] of Object.entries(input)) {
    /* 键先 trim：面板提交的是项目 id，前后空格是手误不是新项目；trim 后撞车按重复键报错，
       不能后者覆盖前者（那会静默丢一个覆盖）。 */
    const id = String(rawKey).trim()
    if (id === '') { invalid.push({ key: 'perProject.', value, reason: 'empty-key' }); continue }
    if (id.length > MAX_PROJECT_ID) { invalid.push({ key: 'perProject.' + id.slice(0, 20) + '…', value, reason: 'too-long' }); continue }
    if (seen.has(id)) { invalid.push({ key: 'perProject.' + id, value, reason: 'duplicate-key' }); continue }
    seen.add(id)
    const picked = readProvider(value, 'perProject.' + id, invalid)
    if (picked !== '') table[id] = picked
  }
  if (Object.keys(table).length > MAX_PER_PROJECT) {
    invalid.push({ key: 'perProject', value: Object.keys(table).length, reason: 'too-many' })
  }
  return table
}

function readWeKnora(input, invalid) {
  if (!isPlainObject(input)) {
    invalid.push({ key: 'weknora', value: input, reason: 'not-object' })
    return undefined
  }
  const sink = {}
  for (const [key, value] of Object.entries(input)) {
    /* apiKeySet 是 /state 回读的形状（只读回声）：面板会把整块 weknora 原样带回，
       这里忽略而不是判 unknown-field，否则「打开面板点保存」直接 400。 */
    if (key === 'apiKeySet') continue
    if (SINK_LIMITS[key] === undefined) { invalid.push({ key: 'weknora.' + key, value, reason: 'unknown-field' }); continue }
    if (typeof value !== 'string') { invalid.push({ key: 'weknora.' + key, value, reason: 'not-string' }); continue }
    if (value.trim().length > SINK_LIMITS[key]) {
      invalid.push({ key: 'weknora.' + key, value: value.slice(0, 12) + '…', reason: 'too-long' })
      continue
    }
    sink[key] = value.trim()
  }
  return sink
}

/** 保存后「仍生效」的 weknora-ish 范围：全局 ∪ 所有项目级（Q6 裁定 A）。 */
function weknoraScopes(docs) {
  const scopes = []
  if (docs.provider === 'weknora' || docs.provider === 'both') scopes.push('global')
  for (const [id, value] of Object.entries(docs.perProject)) {
    if (value === 'weknora' || value === 'both') scopes.push('project:' + id)
  }
  return scopes
}

/**
 * 校验 patch 并算出下一份 config.docs（纯函数，不落库）。
 * 任何一项非法 → 抛 docs_config_invalid（一次列清所有问题，不修一半写一半）。
 * 保存后仍有 weknora/both 生效范围而连接没配全 → 抛 docs_config_not_ready（指名缺项与影响范围）。
 */
export function buildDocsConfig(currentDocs, patchDocs) {
  if (!isPlainObject(patchDocs)) {
    throw new DocsConfigError('docs 必须是对象（清空传 {}，null 不等于清空）', {
      invalid: [{ key: 'docs', value: patchDocs, reason: 'not-object' }],
    })
  }
  const invalid = []
  for (const key of Object.keys(patchDocs)) {
    if (!DOC_FIELDS.includes(key)) invalid.push({ key: 'docs.' + key, value: patchDocs[key], reason: 'unknown-field' })
  }

  const provider = patchDocs.provider === undefined ? undefined : readProvider(patchDocs.provider, 'provider', invalid)
  const perProject = patchDocs.perProject === undefined ? undefined : readPerProject(patchDocs.perProject, invalid)
  const weknora = patchDocs.weknora === undefined ? undefined : readWeKnora(patchDocs.weknora, invalid)

  if (invalid.length > 0) {
    throw new DocsConfigError(`文档出口配置非法：${invalid.map(item => item.key + '（' + item.reason + '）').join('、')}`, { invalid })
  }

  const current = sanitizeDocsConfig(currentDocs)
  const merged = {
    provider: provider ?? current.provider,
    perProject: perProject ?? current.perProject,
    weknora: weknora === undefined ? current.weknora : { ...current.weknora, ...weknora },
  }
  const next = sanitizeDocsConfig(merged, current)

  const scopes = weknoraScopes(next)
  if (scopes.length > 0) {
    const ready = weknoraReady(next.weknora)
    if (!ready.ok) {
      throw new DocsConfigError(`WeKnora 出口没配全：缺 ${ready.missing.join(' / ')}（影响：${scopes.join('、')}）`, {
        code: 'docs_config_not_ready',
        missing: ready.missing,
        scopes,
      })
    }
  }
  return next
}

/** 给 applyConfig 用的一行接线：与 store.mutate 的其余字段共享同一份快照。 */
export function writeDocsConfig(config, patchDocs) {
  config.docs = buildDocsConfig(config.docs, patchDocs)
}
