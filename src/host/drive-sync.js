// 云盘目录的建立与复用（需要 IO，所以 larkJson 由调用方传进来，避免和 executor 成环）。
//
// 目录形状见 drive-folders.js：根 → 项目 → 需求 → 按类型分类的产物子文件夹。
// 每个目录都是「先列同层同名、有就复用，没有才建」——重复建会让同一个东西出现两份目录。
import { artifactFolderName, findFolder, projectFolderName, requirementFolderNameOf } from './drive-folders.js'

const itemsOf = data => data?.items ?? data?.files ?? []

/**
 * larkJson 由调用方传入（避免与 executor 成环）。**漏传就会在调用点炸成
 * 「larkJson is not a function」并被上层 catch 误当成"云盘暂时不可用"** ——
 * 2026-11-20 真机上交付物就一直没进「01 需求文档」子目录，查了两轮才定位到是漏传参数。
 */
function needLark(larkJson, name) {
  if (typeof larkJson !== 'function') throw new Error(`${name} 需要传入 larkJson（云盘调用入口），当前是 ${typeof larkJson}`)
}
// 不要加 --page-all：它会把『[page 1] fetching...』打到 stdout，和 JSON 混在一起导致解析失败（真机踩过）。
// 一个父目录下 200 条足够；真超了也只是复用不上、会多建一个目录，不会出错。
const driveArgs = parent => ['drive', 'files', 'list', '--folder-token', parent, '--page-size', '200']

/** 项目级文件夹：缓存在 config.feishu.projectFolders[projectId]，没挂项目落「未归属项目」。 */
export async function ensureProjectFolder(store, requirement, larkJson) {
  needLark(larkJson, 'ensureProjectFolder')
  const state = store.snapshot()
  const root = String(state.config.feishu.driveFolder ?? '').trim()
  if (root === '') throw new Error('还没配置飞书云盘根文件夹（设置 → 飞书 · 云盘根文件夹）')
  const projects = state.config.projects ?? []
  const project = String(requirement?.project ?? '') === '' ? undefined : projects.find(item => item.id === requirement.project)
  const key = project === undefined ? '__unassigned__' : String(project.id)
  const cached = (state.config.feishu.projectFolders ?? {})[key]
  /* 缓存要记住「建在哪个根目录下」：换了云盘根目录后旧 token 仍指向旧根，
     新需求会静默落到旧根的项目文件夹里（面板上没有「已迁移」以外的提示）。
     老缓存没有 root 字段，按未命中处理一次：会按名字在新根下复用或重建，之后写回 root。 */
  if (cached !== undefined && String(cached.token ?? '').trim().length > 0 && String(cached.root ?? '') === root) return { ...cached, project }
  const name = projectFolderName(project)
  const listed = await larkJson(driveArgs(root), 45000)
  const existing = listed.ok ? findFolder(itemsOf(listed.data), name) : undefined
  let folder
  if (existing !== undefined) {
    folder = { token: String(existing.token ?? ''), url: String(existing.url ?? ''), name, root, at: Date.now(), error: '' }
  } else {
    const created = await larkJson(['drive', '+create-folder', '--folder-token', root, '--name', name], 45000)
    if (!created.ok) throw new Error(created.error)
    folder = { token: String(created.data.folder_token ?? ''), url: String(created.data.url ?? ''), name, root, at: Date.now(), error: '' }
  }
  await store.mutate(draft => {
    const folders = { ...(draft.config.feishu.projectFolders ?? {}) }
    folders[key] = folder
    draft.config.feishu.projectFolders = folders
  })
  return { ...folder, project }
}

/** 需求文件夹（建在项目文件夹下面）。已建过就直接返回缓存的。 */
export async function ensureRequirementFolder(store, requirementId, larkJson) {
  needLark(larkJson, 'ensureRequirementFolder')
  const state = store.snapshot()
  const requirement = state.requirements.find(item => item.id === requirementId)
  if (requirement === undefined) throw new Error(`no requirement ${requirementId}`)
  const current = requirement.folder ?? {}
  if (String(current.token ?? '').trim().length > 0) return current
  const projectFolder = await ensureProjectFolder(store, requirement, larkJson)
  const parent = String(projectFolder.token ?? '').trim()
  if (parent === '') throw new Error(projectFolder.error ?? '项目文件夹没建好')
  const name = requirementFolderNameOf(requirement)
  const listed = await larkJson(driveArgs(parent), 45000)
  const existing = listed.ok ? findFolder(itemsOf(listed.data), name) : undefined
  const created = existing !== undefined
    ? { ok: true, data: { folder_token: existing.token, url: existing.url, name } }
    : await larkJson(['drive', '+create-folder', '--folder-token', parent, '--name', name], 45000)
  if (!created.ok) {
    await store.mutate(draft => {
      const target = draft.requirements.find(item => item.id === requirementId)
      if (target !== undefined) target.folder = { ...(target.folder ?? {}), error: String(created.error ?? '').slice(0, 300) }
    })
    return { token: '', url: '', name, at: 0, error: String(created.error ?? '').slice(0, 300) }
  }
  const folder = {
    token: String(created.data.folder_token ?? ''),
    url: String(created.data.url ?? ''),
    name: String(created.data.name ?? name),
    parentToken: parent,
    parentName: String(projectFolder.name ?? ''),
    at: Date.now(),
    error: '',
  }
  await store.mutate(draft => {
    const target = draft.requirements.find(item => item.id === requirementId)
    if (target !== undefined) target.folder = folder
  })
  return folder
}

/** 需求文件夹里按产物类型分的子目录（01 需求文档 / 02 设计文档 …），按需创建并缓存。 */
export async function ensureKindFolder(store, requirementId, kind, larkJson) {
  needLark(larkJson, 'ensureKindFolder')
  const name = artifactFolderName(kind)
  const state = store.snapshot()
  const requirement = state.requirements.find(item => item.id === requirementId)
  if (requirement === undefined) throw new Error(`no requirement ${requirementId}`)
  const folder = requirement.folder ?? {}
  const cached = (folder.kinds ?? {})[name]
  if (String(cached?.token ?? '').trim().length > 0) return cached
  const parent = String(folder.token ?? '').trim()
  if (parent === '') throw new Error('需求文件夹还没建好，先建一次文件夹')
  const listed = await larkJson(driveArgs(parent), 45000)
  const existing = listed.ok ? findFolder(itemsOf(listed.data), name) : undefined
  let saved
  if (existing !== undefined) {
    saved = { token: String(existing.token ?? ''), url: String(existing.url ?? ''), name, at: Date.now() }
  } else {
    const created = await larkJson(['drive', '+create-folder', '--folder-token', parent, '--name', name], 45000)
    if (!created.ok) throw new Error(created.error)
    saved = { token: String(created.data.folder_token ?? ''), url: String(created.data.url ?? ''), name, at: Date.now() }
  }
  await store.mutate(draft => {
    const target = draft.requirements.find(item => item.id === requirementId)
    if (target === undefined) return
    target.folder = { ...(target.folder ?? {}), kinds: { ...(target.folder?.kinds ?? {}), [name]: saved } }
  })
  return saved
}

/**
 * 删掉一条需求的云盘目录（丢进回收站，不是彻底清除）。
 *
 * 为什么需要：以前删需求只删台账，云盘目录留着 —— 于是自检跑一次多一个目录，
 * 200 个同名文件夹就是这么攒出来的。删需求时带上 deleteFolder 才动云盘（默认不动，避免误删）。
 */
export async function deleteRequirementFolder(store, requirementId, larkJson) {
  needLark(larkJson, 'deleteRequirementFolder')
  const state = store.snapshot()
  const requirement = state.requirements.find(item => item.id === requirementId)
  const folder = requirement?.folder ?? {}
  const token = String(folder.token ?? '').trim()
  if (token === '') return { ok: true, skipped: '这条需求没有云盘目录' }
  const removed = await larkJson(['drive', '+delete', '--file-token', token, '--type', 'folder', '--yes'], 60000)
  if (!removed.ok) return { ok: false, error: removed.error }
  // 需求马上要被删掉；如果还在，就把 folder 清空，别留一个指向回收站的 token
  await store.mutate(draft => {
    const target = draft.requirements.find(item => item.id === requirementId)
    if (target !== undefined) target.folder = {}
  })
  return { ok: true, name: String(folder.name ?? '') }
}

/**
 * 删掉一个项目的云盘目录（丢回收站）。删项目时不会自动调用，要显式传 deleteFolder。
 *
 * 为什么需要：项目目录不删就会一直留在根下 —— 这也是以前根目录攒出几百个同名文件夹的成因之一。
 */
export async function deleteProjectFolder(store, projectId, larkJson) {
  needLark(larkJson, 'deleteProjectFolder')
  const state = store.snapshot()
  const folders = state.config.feishu.projectFolders ?? {}
  const folder = folders[String(projectId)]
  if (folder === undefined || String(folder.token ?? '').trim() === '') return { ok: true, skipped: '这个项目没有云盘目录' }
  const removed = await larkJson(['drive', '+delete', '--file-token', String(folder.token), '--type', 'folder', '--yes'], 60000)
  if (!removed.ok) return { ok: false, error: removed.error }
  await store.mutate(draft => {
    const next = { ...(draft.config.feishu.projectFolders ?? {}) }
    delete next[String(projectId)]
    draft.config.feishu.projectFolders = next
  })
  return { ok: true, name: String(folder.name ?? '') }
}
