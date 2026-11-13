// SQLite 用例执行器：对着一个库跑一条语句，断言行数与首行某列的值。
// 和 shell 一样**默认关闭**（config.testing.allowDb）——打开它等于把「读宿主上的任意库」交给看板；
// 默认按只读打开，要写入必须显式 readOnly: false。
import { DatabaseSync } from 'node:sqlite'

/** 用例里的 db 字段：file + sql 必填，其余是断言。 */
export function sanitizeDbCase(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const file = String(raw.file ?? '').trim().slice(0, 400)
  const sql = String(raw.sql ?? '').trim().slice(0, 2000)
  if (file === '' || sql === '') return null
  return {
    file,
    sql,
    params: (Array.isArray(raw.params) ? raw.params : []).slice(0, 20).map(value => (typeof value === 'number' ? value : String(value ?? '').slice(0, 200))),
    expectRows: Number.isInteger(Number(raw.expectRows)) ? Math.max(0, Number(raw.expectRows)) : null,
    expectColumn: String(raw.expectColumn ?? '').slice(0, 60),
    expectValue: raw.expectValue === undefined || raw.expectValue === null ? null : String(raw.expectValue).slice(0, 200),
    readOnly: raw.readOnly !== false,
  }
}

export async function runDbCase(item, config) {
  const started = Date.now()
  const spec = item.db
  if (config?.testing?.allowDb !== true) {
    return { ok: false, status: 0, ms: 0, error: '这台机器没开数据库用例：设置 → 测试执行 里打开「允许数据库用例」', preview: '' }
  }
  let database
  try {
    database = new DatabaseSync(spec.file, { readOnly: spec.readOnly })
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, error: '打不开这个库：' + String(error?.message ?? error).slice(0, 200), preview: '' }
  }
  try {
    const rows = database.prepare(spec.sql).all(...(spec.params ?? []))
    const problems = []
    if (spec.expectRows !== null && rows.length !== spec.expectRows) problems.push('行数 ' + rows.length + '（期望 ' + spec.expectRows + '）')
    if (spec.expectColumn !== '' && spec.expectValue !== null) {
      const first = rows[0] ?? {}
      const actual = first[spec.expectColumn]
      if (String(actual) !== spec.expectValue) problems.push('首行 ' + spec.expectColumn + ' = ' + String(actual) + '（期望 ' + spec.expectValue + '）')
    }
    return {
      ok: problems.length === 0,
      status: 200,
      ms: Date.now() - started,
      error: problems.join('；').slice(0, 300),
      preview: JSON.stringify(rows.slice(0, 5)).slice(0, 600),
    }
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, error: '语句执行失败：' + String(error?.message ?? error).slice(0, 200), preview: '' }
  } finally {
    try { database.close() } catch { /* 已经关了 */ }
  }
}
