#!/usr/bin/env node
/**
 * 云盘孤儿目录清理（npm run drive:gc）。
 *
 *   npm run drive:gc -- --base http://127.0.0.1:<dsh 端口>            # 只体检，不删
 *   npm run drive:gc -- --base … --apply                             # 真删（进飞书回收站）
 *   npm run drive:gc -- --base … --strict                            # 有孤儿就退出码 1（给定时任务用）
 *
 * 需要 STUDIO_TOKEN（`/studio-api` 过宿主的信任栅栏，脚本要用 dsh web 的启动 token 换 cookie）：
 *   STUDIO_TOKEN=<dsh web 启动 token> npm run drive:gc -- --base http://127.0.0.1:<dsh 端口>
 *
 * 判定逻辑在 src/host/drive-gc.js（纯函数，有单测）：**只删名字像需求目录（REQ-*）
 * 且台账里没有任何引用的文件夹**，其余一律保留。文件永远不碰。
 *
 * 为什么需要：自检/演示每跑一次都会建目录，删台账时没带 deleteFolder 就会留下。
 * 2026-11-20 真机上根目录攒了 300 多个同名文件夹，手工清了半小时，还踩了
 * 「并发删除被飞书判 resource contention」和「参数里的 | 被 cmd.exe 当管道」两个坑。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyDriveFolders, gcSummary } from '../src/host/drive-gc.js'
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const base = value('base', process.env.STUDIO_BASE ?? '')
if (base === '') {
  console.error('用法：npm run drive:gc -- --base http://127.0.0.1:<dsh 端口> [--apply] [--strict]')
  process.exit(2)
}
const apply = flag('apply')
// 带会话的 fetch：本文件里的 `api` 已经是「GET 并返回 JSON」的本地包装，所以这里换个名字避免重名。
const studioApi = studioFetch(base, launchTokenFromEnv())

const api = async path => {
  const res = await studioApi('/studio-api' + path)
  return res.json()
}

/** 调 lark-cli。Windows 上是 .cmd 壳：参数要自己加引号并开 windowsVerbatimArguments，
 *  否则 `|`、`&` 会被 cmd.exe 当语法字符（真机踩过）。 */
const lark = args => new Promise(resolve => {
  const quoted = [...args, '--as', 'user', '--json'].map(a => (/[\s&|<>^%"']/.test(a) || a === '' ? `"${a}"` : a))
  const isWin = process.platform === 'win32'
  const file = isWin ? (process.env.ComSpec ?? 'cmd.exe') : 'lark-cli'
  const argvList = isWin ? ['/c', 'lark-cli', ...quoted] : [...args, '--as', 'user', '--json']
  const child = spawn(file, argvList, { windowsHide: true, windowsVerbatimArguments: isWin, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), 40000)
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  child.on('close', () => {
    clearTimeout(timer)
    try {
      const parsed = JSON.parse(out.trim())
      resolve(parsed.ok === false ? { ok: false, error: JSON.stringify(parsed.error ?? {}).slice(0, 240) } : { ok: true, data: parsed.data ?? {} })
    } catch { resolve({ ok: false, error: (err || out).slice(0, 240) }) }
  })
})

const state = (await api('/state')).state
const root = String(state.config.feishu.driveFolder ?? '').trim()
if (root === '') {
  console.error('没有配置云盘根文件夹（设置 → 飞书 · 云盘根文件夹）')
  process.exit(2)
}
const projectFolders = Object.fromEntries(
  Object.entries(state.config.feishu.projectFolders ?? {}).map(([key, entry]) => [key, String(entry?.token ?? '')]),
)
const references = {
  requirementTokens: state.requirements.map(item => String(item.folder?.token ?? '')).filter(Boolean),
  projectFolders,
  liveProjectIds: (state.config.projects ?? []).map(item => String(item.id)),
  unassignedToken: String(projectFolders.__unassigned__ ?? ''),
}

// 分页拉全量
const items = []
let pageToken = ''
for (let page = 0; page < 20; page += 1) {
  const args = ['drive', 'files', 'list', '--folder-token', root, '--page-size', '200']
  if (pageToken !== '') args.push('--page-token', pageToken)
  const listed = await lark(args)
  if (listed.ok !== true) {
    console.error('列云盘目录失败：', listed.error)
    process.exit(1)
  }
  items.push(...(listed.data.files ?? listed.data.items ?? []))
  if (listed.data.has_more !== true || String(listed.data.next_page_token ?? '') === '') break
  pageToken = String(listed.data.next_page_token)
}

const result = classifyDriveFolders(items, references)
console.log(`云盘根目录 ${items.length} 项 —— ${gcSummary(result)}`)
for (const item of result.keep.slice(0, 8)) console.log(`  保留 ${item.name}（${item.reason}）`)
if (result.keep.length > 8) console.log(`  保留 …还有 ${result.keep.length - 8} 个`)
for (const item of result.orphan.slice(0, 15)) console.log(`  孤儿 ${item.name}`)
if (result.orphan.length > 15) console.log(`  孤儿 …还有 ${result.orphan.length - 15} 个`)

if (result.orphan.length === 0) {
  console.log('没有孤儿目录')
  process.exit(0)
}
if (apply !== true) {
  console.log('（体检模式，什么都没删。要真删加 --apply）')
  process.exit(flag('strict') ? 1 : 0)
}

// 串行删除 + 退避重试：并发会被飞书判 1061045 resource contention（真机踩过）
const manifest = { at: new Date().toISOString(), root, deleted: [], failed: [] }
for (const [index, item] of result.orphan.entries()) {
  let removed = await lark(['drive', '+delete', '--file-token', item.token, '--type', 'folder', '--yes'])
  for (let attempt = 0; attempt < 4 && removed.ok !== true && /1061045|resource contention|timeout/i.test(String(removed.error ?? '')); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)))
    removed = await lark(['drive', '+delete', '--file-token', item.token, '--type', 'folder', '--yes'])
  }
  if (removed.ok === true) manifest.deleted.push({ name: item.name, token: item.token })
  else if (!/file has been delete/i.test(String(removed.error ?? ''))) manifest.failed.push({ name: item.name, token: item.token, error: String(removed.error ?? '').slice(0, 200) })
  if ((index + 1) % 20 === 0) console.log(`  已处理 ${index + 1}/${result.orphan.length}`)
}
mkdirSync(join(repo, 'tmp'), { recursive: true })
const manifestPath = join(repo, 'tmp', `drive-gc-${Date.now()}.json`)
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
console.log(`删除完成：成功 ${manifest.deleted.length}，失败 ${manifest.failed.length}；清单 ${manifestPath}`)
process.exit(manifest.failed.length === 0 ? 0 : 1)
