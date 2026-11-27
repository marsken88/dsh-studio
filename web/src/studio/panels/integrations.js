/* Settings panels lifted out of client.src.js; shared handles come from the studio context.
 *
 * 面板内部已经全部换成 BoardUI（Tailwind v4 token + 4px 档位），不再用手写类：
 *   - 分区 = 卡片：rounded-xl + border-separator-border + bg-background-primary-default + p-4
 *   - 小节标题 text-title-2-semibold、说明 text-caption-1-regular text-text-tertiary
 *   - 行 = 分隔线（1px + 末行去掉），动作用 BoardUI Button，状态用 Chip
 *   - 空态用 boardui/empty-state（BoardUI 没有空态组件，这是它的 token 拼的等价物）
 *   - 表单控件仍走 TextField / SelectField / ChipField / CheckField / SwitchToggle 适配器
 *   - 列表分区不再走共享的 Editor（那是旧的 panel 那套），这里按同一套 token 内联
 *
 * 最外层容器是纯 Tailwind（设置页外壳已迁 BoardUI），不再借旧的 panel 类过渡。原注释：
 * 分区卡片自带描边与底色，容器不再叠加表面。
 */

import { client } from '../context.js'
import { Button } from '../../boardui/index'
import { EmptyState } from '../../boardui/empty-state'
import { diffDocsReadback, overridesFromDocs } from '../docs-readback.js'

/* 设置页容器：纯 Tailwind（设置页外壳已迁 BoardUI）。 */
const PANE = 'flex min-w-0 flex-col gap-3'

const SECTION = 'flex min-w-0 flex-col gap-3 rounded-xl border border-separator-border bg-background-primary-default p-4'
const SECTION_HEAD = 'flex flex-wrap items-start justify-between gap-3'
const SECTION_TITLE = 'text-title-2-semibold text-text-primary'
const DESC = 'text-caption-1-regular text-text-tertiary'
const FIELD = 'flex min-w-0 flex-col gap-1'
const LABEL = 'text-caption-1-medium text-text-secondary'
const HINT = 'text-caption-1-regular text-text-tertiary'
const ERR = 'text-caption-1-regular text-text-error-primary'
const OK = 'text-caption-1-regular text-state-success-text'
const ROW = 'flex min-w-0 flex-wrap items-center gap-2'
const LISTROW = 'flex min-w-0 items-start justify-between gap-3 border-b border-separator-border py-3 last:border-b-0 last:pb-0'
const LISTROW_MAIN = 'flex min-w-0 flex-1 flex-col gap-1'
const LISTROW_TITLE = 'flex flex-wrap items-center gap-2 text-body-2-medium text-text-primary'
const LISTROW_ACTIONS = 'flex shrink-0 flex-wrap items-center gap-2'

/* 列表分区：标题 + 说明 + 新增按钮，下面是行；没有行就是空态。
   以前这里调共享 Editor（panel 壳 / 头 / 体三层），迁移后由面板自己拼。 */
function listSection({ h, title, hint, addLabel, onAdd, rows, empty, hook }) {
  return h('div', { className: SECTION, 'data-section': hook },
    h('div', { className: SECTION_HEAD },
      h('div', { className: 'flex min-w-0 flex-col gap-1' },
        h('div', { className: SECTION_TITLE }, title),
        hint === undefined || hint === null ? null : h('div', { className: DESC }, hint),
      ),
      h(Button, { variant: 'secondary', size: 'sm', onClick: onAdd }, addLabel ?? '新增'),
    ),
    rows.length === 0
      ? h(EmptyState, { title: empty ?? '还没有内容。' })
      : h('div', { className: 'flex min-w-0 flex-col' }, rows),
  )
}

/* 一行表单：标签 + 控件 + 可选说明。 */
function fieldOf(h, label, control, hint) {
  return h('div', { className: FIELD },
    h('div', { className: LABEL }, label),
    control,
    hint === undefined || hint === null ? null : h('div', { className: HINT }, hint),
  )
}

export function ReposPanel({ config, onChanged }) {
  const { h, api, toast, confirmDialog, tipOf, TextField, ChipField, SwitchToggle, SideDrawer, React } = client()
  const projects = config.gitlab?.projects ?? []
  const [draft, setDraft] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [note, setNote] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const save = async () => {
    if (draft === null) return
    setBusy(true); setError(null); setNote(null)
    try { await api('/repos/save', { project: draft }); setDraft(null); setNote('已保存'); toast('已保存'); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const remove = async project => {
    if (!(await confirmDialog(`删除 GitLab 项目「${project.name}」？已同步的卡片会保留。`, { title: '删除 GitLab 项目', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null)
    try { await api('/repos/delete', { id: project.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const test = async project => {
    setBusy(true); setError(null); setNote(null)
    try { const out = await api('/repos/test', { id: project.id }); setNote(`连通：${project.project}（示例 Issue ${out.sample} 条）`) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const sync = async project => {
    setBusy(true); setError(null); setNote(null)
    try {
      const out = await api('/gitlab/sync', { project: project.id })
      const row = (out.summary?.projects ?? [])[0]
      setNote(row === undefined ? '没有可同步的项目' : `${row.name}：拉取 ${row.fetched}，新建 ${row.created}${row.error ? '，错误 ' + row.error : ''}`)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const set = (key, value) => setDraft({ ...draft, [key]: value })

  const rows = projects.map(project => h('div', { className: LISTROW, key: project.id, 'data-repo-row': '' },
    h('div', { className: LISTROW_MAIN },
      h('div', { className: LISTROW_TITLE },
        h('span', { className: 'min-w-0 truncate' }, project.name || project.project),
        project.syncEnabled ? h(ChipField, { variant: 'gray' }, '自动同步') : null,
        project.tokenSet ? null : h(ChipField, { variant: 'rose' }, '缺令牌'),
      ),
      h('div', { className: HINT }, `${project.url || config.gitlab.url || '（未填地址）'} / ${project.project}${project.lastSyncAt ? ' · 上次 ' + new Date(project.lastSyncAt).toLocaleString() : ''}`),
      project.lastSyncError ? h('div', { className: ERR }, project.lastSyncError) : null,
    ),
    h('div', { className: LISTROW_ACTIONS },
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => void sync(project) }, '同步'),
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => void test(project) }, '测试'),
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft({ ...project, token: '' }) }, '编辑'),
      tipOf('删除这个项目（卡不会删）', h(Button, { variant: 'danger', size: 'sm', disabled: busy, onClick: () => void remove(project), 'data-danger': '1' }, '删除')),
    ),
  ))

  return h('div', { className: PANE, 'data-panel': 'integrations-repos' },
    listSection({
      h, hook: 'repos',
      title: '代码仓库（GitLab，可以有多个）',
      hint: '每个项目单独填地址、项目路径和令牌；同步时按项目分开去重，两个仓库都有 #12 也不会串。',
      rows, addLabel: '新增项目',
      onAdd: () => setDraft({ id: '', name: '', url: config.gitlab?.url ?? '', project: '', token: '', syncEnabled: false, syncLabel: '' }),
      empty: '还没有项目，点「新增项目」。',
    }),
    note !== null ? h('div', { className: OK, role: 'status' }, note) : null,
    error !== null && draft === null ? h('div', { className: ERR, role: 'alert' }, error) : null,
    draft === null ? null : h(SideDrawer, {
      title: draft.id ? `编辑仓库：${draft.name || draft.project}` : '新增仓库',
      hint: '一个仓库对应 GitLab 上的一个项目；令牌只写盘不回显，留空表示不修改。',
      onClose: () => setDraft(null),
      footer: [
        h(Button, { key: 'save', variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
        h(Button, { key: 'cancel', variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: ERR }, error) : null,
      ],
    },
        fieldOf(h, '显示名',
          h(TextField, { value: draft.name, placeholder: '订单服务', onChange: e => set('name', e.target.value) })),
        fieldOf(h, 'GitLab 地址',
          h(TextField, { value: draft.url, placeholder: 'https://gitlab.example.com', onChange: e => set('url', e.target.value) })),
        fieldOf(h, '项目路径（含 namespace）',
          h(TextField, { value: draft.project, placeholder: 'backend/order-service', onChange: e => set('project', e.target.value) })),
        fieldOf(h, draft.tokenSet ? 'Access Token（已设置，留空则不修改）' : 'Access Token',
          h(TextField, {
            type: 'password', value: draft.token,
            placeholder: draft.tokenSet ? '••••••••' : 'glpat-…',
            onChange: e => set('token', e.target.value),
          }),
          '需要 api 权限；只写入磁盘，不回显。'),
        fieldOf(h, '只同步带此标签的 Issue',
          h(TextField, { value: draft.syncLabel, placeholder: '留空则同步全部 open Issue', onChange: e => set('syncLabel', e.target.value) })),
        h(SwitchToggle, {
          checked: draft.syncEnabled === true,
          label: '每分钟自动把这个项目的新 Issue 拉成卡片',
          onChange: e => set('syncEnabled', e.target.checked),
        }),
    ),
  )
}

const BOT_EVENTS = [
  { key: 'change', label: '卡片状态变化' },
  { key: 'sla', label: '缺陷 SLA 超时' },
  { key: 'bug', label: '自动开缺陷' },
  { key: 'release', label: '版本发布' },
]

const botEventNames = bot => {
  const events = bot.events !== null && typeof bot.events === 'object' ? bot.events : null
  if (events === null) return bot.notifyOnChange === false ? [] : ['change', 'sla', 'bug', 'release']
  return BOT_EVENTS.filter(item => events[item.key] !== false).map(item => item.label)
}

export function BotsPanel({ config, onChanged }) {
  const { h, api, toast, confirmDialog, TextField, CheckField, SwitchToggle, SideDrawer, React } = client()
  const bots = config.feishu?.bots ?? []
  const [draft, setDraft] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [note, setNote] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [driveFolder, setDriveFolder] = React.useState(config.feishu?.driveFolder ?? '')
  const [autoSync, setAutoSync] = React.useState(config.feishu?.autoSyncArtifacts !== false)
  const [driveBusy, setDriveBusy] = React.useState(false)
  const [driveNote, setDriveNote] = React.useState(null)
  const saveDrive = async () => {
    setDriveBusy(true); setDriveNote(null)
    try {
      await api('/config', { feishu: { driveFolder: driveFolder.trim(), autoSyncArtifacts: autoSync } })
      setDriveNote('已保存')
      await onChanged()
    } catch (cause) { setDriveNote(cause instanceof Error ? cause.message : String(cause)) } finally { setDriveBusy(false) }
  }
  const save = async () => {
    if (draft === null) return
    setBusy(true); setError(null); setNote(null)
    try { await api('/bots/save', { bot: draft }); setDraft(null); setNote('已保存'); toast('已保存'); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const remove = async bot => {
    if (!(await confirmDialog(`删除飞书机器人「${bot.name}」？`, { title: '删除机器人', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null)
    try { await api('/bots/delete', { id: bot.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const test = async bot => {
    setBusy(true); setError(null); setNote(null)
    try {
      const out = await api('/feishu/test', { id: bot.id })
      const row = (out.results ?? [])[0]
      setNote(row !== undefined && row.ok === true ? `「${bot.name}」测试消息已发送` : `「${bot.name}」发送失败：${row?.error ?? '检查 Webhook'}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const set = (key, value) => setDraft({ ...draft, [key]: value })
  const eventOn = key => {
    const events = draft.events !== null && typeof draft.events === 'object' ? draft.events : null
    if (events === null) return key === 'change' ? draft.notifyOnChange !== false : true
    return events[key] !== false
  }
  const setEvent = (key, value) => {
    const events = draft.events !== null && typeof draft.events === 'object' ? draft.events : {}
    const next = { ...events, [key]: value }
    setDraft({ ...draft, events: next, notifyOnChange: next.change !== false })
  }

  const rows = bots.map(bot => h('div', { className: LISTROW, key: bot.id, 'data-bot-row': '' },
    h('div', { className: LISTROW_MAIN },
      h('div', { className: LISTROW_TITLE },
        h('span', { className: 'min-w-0 truncate' }, bot.name),
        bot.enabled === false ? h('span', { className: HINT }, '已停用') : null,
        bot.webhookSet ? null : h('span', { className: ERR }, '缺 Webhook'),
      ),
      h('div', { className: HINT }, `Webhook ${bot.webhookHint || '（未设置）'}${bot.chatId ? ' · 群 ' + bot.chatId : ''} · 收：${botEventNames(bot).join(' / ') || '什么都不收'}`),
    ),
    h('div', { className: LISTROW_ACTIONS },
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => void test(bot) }, '测试'),
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft({ ...bot, webhook: '' }) }, '编辑'),
      h(Button, { variant: 'danger', size: 'sm', disabled: busy, onClick: () => void remove(bot), 'data-danger': '1' }, '删除'),
    ),
  ))

  return h('div', { className: PANE, 'data-panel': 'integrations-bots' },
    listSection({
      h, hook: 'bots',
      title: '飞书机器人（可以有多个）',
      hint: '一个群建一个机器人，并在下面勾选它要收哪些事件；研发群只勾缺陷相关，产品群只勾版本发布。',
      rows, addLabel: '新增机器人',
      onAdd: () => setDraft({ id: '', name: '', webhook: '', chatId: '', notifyOnChange: true, events: { change: true, sla: true, bug: true, release: true }, enabled: true }),
      empty: '还没有机器人。',
    }),
    note !== null ? h('div', { className: OK, role: 'status' }, note) : null,
    error !== null && draft === null ? h('div', { className: ERR, role: 'alert' }, error) : null,
    h('div', { className: SECTION, 'data-section': 'drive-archive' },
      h('div', { className: SECTION_TITLE }, '云盘归档（产物文档）'),
      fieldOf(h, '云盘根文件夹 token 或链接',
        h(TextField, {
          value: driveFolder, placeholder: 'IuJPfTCtWlDrzwdCFmLc71aynbg 或文件夹链接',
          onChange: e => setDriveFolder(e.target.value),
        }),
        `每条需求会在它下面建一个「编号 + 标题」的同名文件夹，交付物写成文件夹里的一份 .md 文档。飞书授权：${config.feishu?.larkReady ? 'lark-cli 已就绪' : 'lark-cli 未就绪或未授权'}`),
      h(SwitchToggle, {
        checked: autoSync,
        label: '专家登记交付物时自动归档（关掉就只存平台里）',
        onChange: e => setAutoSync(e.target.checked),
      }),
      h('div', { className: ROW },
        h('Button', { variant: 'primary', size: 'sm', disabled: driveBusy, onClick: () => void saveDrive() }, driveBusy ? '保存中…' : '保存'),
        driveNote !== null ? h('div', { className: HINT, role: 'status' }, driveNote) : null,
      ),
    ),
    draft === null ? null : h(SideDrawer, {
      title: draft.id ? `编辑机器人：${draft.name || draft.id}` : '新增机器人',
      hint: 'Webhook 只写盘不回显，留空表示不修改；一个群建一个机器人即可。',
      onClose: () => setDraft(null),
      footer: [
        h(Button, { key: 'save', variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
        h(Button, { key: 'cancel', variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: ERR }, error) : null,
      ],
    },
        fieldOf(h, '名字',
          h(TextField, { value: draft.name, placeholder: '研发群通知', onChange: e => set('name', e.target.value) })),
        fieldOf(h, draft.webhookSet ? 'Webhook（已设置，留空则不修改）' : 'Webhook',
          h(TextField, {
            type: 'password', value: draft.webhook,
            placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
            onChange: e => set('webhook', e.target.value),
          }),
          '在飞书群里「添加机器人 → 自定义机器人」即可拿到，不需要自建应用。'),
        fieldOf(h, '备注群 chat_id（可选）',
          h(TextField, { value: draft.chatId, placeholder: 'oc_…', onChange: e => set('chatId', e.target.value) })),
        fieldOf(h, '收哪些事件',
          h('div', { className: 'flex min-w-0 flex-col gap-2' },
            BOT_EVENTS.map(item => h(CheckField, {
              key: item.key,
              checked: eventOn(item.key),
              onChange: e => setEvent(item.key, e.target.checked),
            }, item.label)),
          ),
          '不勾任何一项就等于这个群静默（只保留测试消息）。'),
        h(SwitchToggle, {
          checked: draft.enabled !== false,
          label: '启用',
          onChange: e => set('enabled', e.target.checked),
        }),
    ),
  )
}

export function SkillsPanel({ config, onChanged }) {
  const { h, api, toast, confirmDialog, TextField, ChipField, CheckField, SwitchToggle, MdField, SideDrawer , React } = client()
  const [data, setData] = React.useState(null)
  const [draft, setDraft] = React.useState(null)
  const [error, setError] = React.useState(null)
  const fileRef = React.useRef(null)
  const [note, setNote] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [overwrite, setOverwrite] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const payload = await api('/skills')
      setData({ root: payload.root, skills: payload.skills ?? [], onDisk: payload.onDisk ?? [] })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [])
  React.useEffect(() => { void load() }, [load])

  const skills = data?.skills ?? []
  const onDisk = data?.onDisk ?? []
  const users = name => (config.experts ?? []).filter(expert => (expert.skills ?? []).includes(name))

  const set = (key, value) => setDraft({ ...draft, [key]: value })
  const save = async () => {
    if (draft === null) return
    setBusy(true); setError(null); setNote(null)
    try {
      const payload = await api('/skills/save', {
        skill: {
          name: draft.name, description: draft.description, whenToUse: draft.whenToUse,
          tags: draft.tags, content: draft.content, enabled: draft.enabled !== false,
          // 项目范围：空 = 全局技能；填了项目 id 就只在那些项目的派单里注入。
          projects: String(draft.projects ?? '').split(/[,，\s]+/).map(item => item.trim()).filter(Boolean),
        },
      })
      setDraft(null)
      setNote(payload.warning ?? (payload.file ? `已写入 ${payload.file}` : '已保存'))
      await load(); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const remove = async skill => {
    if (!(await confirmDialog(`删除技能「${skill.name}」？磁盘上的 SKILL.md 也会一起删掉。`, { title: '删除技能', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null); setNote(null)
    try { await api('/skills/delete', { name: skill.name }); await load(); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const resync = async () => {
    setBusy(true); setError(null); setNote(null)
    try {
      const payload = await api('/skills/sync', {})
      setNote(`已重新写入 ${(payload.written ?? []).length} 条技能`)
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const upload = async file => {
    if (file === undefined || file === null) return
    setUploading(true); setError(null); setNote(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      const step = 0x8000
      for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step))
      }
      const payload = await api('/skills/upload', {
        fileName: file.name, dataBase64: window.btoa(binary), overwrite,
      })
      const action = payload.overwritten === true ? '已覆盖' : '已上传'
      setNote(`${action}技能「${payload.skill.name}」${payload.file ? `，写入 ${payload.file}` : ''}`)
      setDraft(null)
      await load(); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setUploading(false) }
  }

  const rows = skills.map(skill => h('div', { className: LISTROW, key: skill.name, 'data-skill-row': '' },
    h('div', { className: LISTROW_MAIN },
      h('div', { className: LISTROW_TITLE },
        h('code', { className: 'font-mono text-caption-1-regular' }, skill.name),
        (skill.tags ?? []).map(tag => h(ChipField, { variant: 'gray', key: tag }, tag)),
        skill.enabled === false ? h('span', { className: HINT }, '草稿/已停用') : null,
        (skill.projects ?? []).length > 0 ? h('span', { className: HINT }, `仅限项目：${skill.projects.join('、')}`) : null,
        onDisk.includes(skill.name) ? null : h('span', { className: ERR }, '未落盘'),
      ),
      h('div', { className: HINT }, skill.description),
      skill.whenToUse ? h('div', { className: HINT }, `何时用：${skill.whenToUse}`) : null,
      h('div', { className: HINT }, (() => {
        const usage = skill.usage
        if (usage === null || usage === undefined || usage.cards === 0) return '还没被用上（挂它的专家还没接过卡）'
        return `用上 ${usage.cards} 张卡（完成 ${usage.done}）${usage.rework > 0 ? `，其中 ${usage.rework} 张被打回（${usage.reworkRate}%）` : '，没有返工'}`
      })()),
      users(skill.name).length > 0
        ? h('div', { className: HINT }, `使用中的专家：${users(skill.name).map(expert => `${expert.name}`).join('、')}`)
        : h('div', { className: DESC }, '还没有专家挂这个技能'),
    ),
    h('div', { className: LISTROW_ACTIONS },
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => { setNote(null); setDraft({ ...skill, editing: true, tags: (skill.tags ?? []).join(', '), projects: (skill.projects ?? []).join(', ') }) } }, '编辑'),
      h(Button, { variant: 'danger', size: 'sm', disabled: busy, onClick: () => void remove(skill), 'data-danger': '1' }, '删除'),
    ),
  ))

  const stray = onDisk.filter(name => !skills.some(skill => skill.name === name))

  return h('div', { className: PANE, 'data-panel': 'integrations-skills' },
    listSection({
      h, hook: 'skills',
      title: '技能库',
      hint: data === null ? '读取中…' : `保存在 ${data.root}/<名字>/SKILL.md，所有专家都能用 skill 工具加载；专家也可以自己用 studio_skill_save 往这里加技能。支持上传 SKILL.md 或包含 SKILL.md 的 .zip 技能包。`,
      rows, addLabel: '新建技能',
      onAdd: () => { setNote(null); setDraft({ name: '', description: '', whenToUse: '', tags: '', projects: '', content: '# 什么时候用\n\n# 步骤\n\n1. \n', enabled: true, editing: false }) },
      empty: '还没有技能。把一次摸索出来的做法写成第一条，下次就不用重新摸索。',
    }),
    stray.length > 0
      ? h('div', { className: HINT }, `磁盘上还有 ${stray.length} 个不归这里管的技能目录：${stray.join('、')}`)
      : null,
    h('div', { className: ROW },
      // 以前把 <input type=file> 藏进长得像按钮的 <label> 里：看起来能点，但
      // **键盘根本到不了**（label 不可聚焦，Tab 跳过它），屏幕阅读器也只报一个标签。
      // 改成正常按钮 + 隐藏的文件输入框：按钮能被 Tab 聚焦、Enter/Space 触发，
      // 真正去点的是那个 1px 的 input。
      h(Button, {
        variant: 'secondary', size: 'sm',
        disabled: uploading,
        title: '上传 SKILL.md 或包含 SKILL.md 的 .zip 技能包',
        onClick: () => fileRef.current?.click(),
      }, uploading ? '上传中…' : '上传技能'),
      h('input', {
        type: 'file',
        accept: '.md,.markdown,.txt,.zip',
        ref: fileRef,
        tabIndex: -1,
        'aria-hidden': 'true',
        style: { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' },
        onChange: event => { const file = event.target.files === null ? undefined : event.target.files[0]; event.target.value = ''; void upload(file) },
      }),
      h(CheckField, {
        checked: overwrite,
        onChange: event => setOverwrite(event.target.checked),
      }, '覆盖同名技能'),
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy || skills.length === 0, onClick: () => void resync() }, '重新写入磁盘'),
      note !== null ? h('span', { className: OK, role: 'status' }, note) : null,
      /* 同步/测试失败以前只在抽屉 footer 里渲染 —— 抽屉没打开时错误完全不显示，
         表现是「按钮灰一下又恢复，像同步成功了」。放到面板级，失败一定看得见。 */
      error !== null && draft === null ? h('span', { className: ERR, role: 'alert' }, error) : null,
    ),
    draft === null ? null : h(SideDrawer, {
      title: draft.editing === true ? `编辑技能：${draft.name}` : '新建技能',
      hint: '技能正文就是一个 SKILL.md：什么情况用、步骤、命令、踩过的坑。保存后写入 ~/.dsh/skills/<名字>/SKILL.md。',
      onClose: () => setDraft(null),
      footer: [
        h(Button, { key: 'save', variant: 'primary', size: 'sm', disabled: busy || draft.name.length === 0 || draft.content.trim().length === 0, onClick: () => void save() }, busy ? '保存中…' : '保存技能'),
        h(Button, { key: 'cancel', variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: ERR }, error) : null,
      ],
    },
        h('div', { className: 'flex min-w-0 items-start gap-2' },
          h('div', { className: 'flex min-w-0 flex-col gap-1', style: { flex: 1 } },
            h('div', { className: LABEL }, '技能名（kebab-case）'),
            h(TextField, {
              value: draft.name, disabled: draft.editing === true,
              placeholder: 'gitlab-mr-review',
              onChange: e => set('name', e.target.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')),
            }),
          ),
          h('div', { className: 'flex min-w-0 flex-col gap-1', style: { flex: 2 } },
            h('div', { className: LABEL }, '什么时候该用（一行，模型据此决定要不要加载）'),
            h(TextField, { value: draft.description, placeholder: '评审 GitLab MR 时：怎么读 diff、怎么留评论', onChange: e => set('description', e.target.value) }),
          ),
        ),
        h('div', { className: 'flex min-w-0 items-start gap-2' },
          h('div', { className: 'flex min-w-0 flex-col gap-1', style: { flex: 2 } },
            h('div', { className: LABEL }, '补充触发条件（选填）'),
            h(TextField, { value: draft.whenToUse, placeholder: '收到 @研发 且带 MR 链接时', onChange: e => set('whenToUse', e.target.value) }),
          ),
          h('div', { className: 'flex min-w-0 flex-col gap-1', style: { flex: 1 } },
            h('div', { className: LABEL }, '标签（逗号分隔）'),
            h(TextField, { value: draft.tags, placeholder: 'gitlab, review', onChange: e => set('tags', e.target.value) }),
          ),
        ),
        fieldOf(h, '项目范围（选填，项目 id 逗号分隔）',
          h(TextField, { value: draft.projects ?? '', placeholder: '留空 = 全局技能；填了只在那些项目的派单里注入', onChange: e => set('projects', e.target.value) })),
        fieldOf(h, '技能正文（Markdown：什么情况用、步骤、命令、坑）',
          h(MdField, {
            rows: 14, value: draft.content,
            placeholder: '# 什么时候用\n\n# 步骤\n\n1. \n\n# 坑\n\n- ',
            onChange: e => set('content', e.target.value),
          })),
        h(SwitchToggle, {
          checked: draft.enabled !== false,
          label: '启用（停用则不写入磁盘）',
          onChange: e => set('enabled', e.target.checked),
        }),
    ),
  )
}
/** 文档出口：artifact 永远是真源，飞书 / WeKnora 只是投影（判据见 src/host/doc-sink.js）。 */
export function DocsSinkPanel({ config, onChanged }) {
  const { h, api, TextField, SelectField, React, confirmDialog } = client()
  const docs = config.docs ?? {}
  const weknora = docs.weknora ?? {}
  const projects = Array.isArray(config.projects) ? config.projects : []
  const [provider, setProvider] = React.useState(docs.provider ?? 'feishu')
  const [baseUrl, setBaseUrl] = React.useState(weknora.baseUrl ?? '')
  const [apiKey, setApiKey] = React.useState('')
  const [tenantId, setTenantId] = React.useState(weknora.tenantId ?? '')
  const [kb, setKb] = React.useState(weknora.knowledgeBaseId ?? '')
  /* 项目级覆盖用一个数组表示（初值 docs.perProject）。服务端是「整表替换」，
     所以保存时永远提交完整表：删掉一行 = 该项目回落到全局默认。 */
  /* 初值走纯函数 overridesFromDocs：它不做项目存在性过滤（未知行默认保留，R9 有单测钉住）。 */
  const [overrides, setOverrides] = React.useState(() => overridesFromDocs(docs.perProject))
  const [addProject, setAddProject] = React.useState('')
  const [addProvider, setAddProvider] = React.useState('feishu')
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState(null)
  const projectOf = id => projects.find(item => String(item.id ?? '') === id)
  /* 保存后用回读值刷新本地状态（R7）：apiKey 回读恒空，控件回到「留空保持不变」的占位。 */
  const applyReadback = next => {
    if (next === null || typeof next !== 'object') return
    setProvider(next.provider ?? 'feishu')
    setOverrides(overridesFromDocs(next.perProject))
    setBaseUrl(next.weknora?.baseUrl ?? '')
    setTenantId(next.weknora?.tenantId ?? '')
    setKb(next.weknora?.knowledgeBaseId ?? '')
    setApiKey('')
  }
  const removeUnknown = async item => {
    /* 未知项目（/state.projects 里没有，多半是已删/归档的项目）默认保留：R9 禁止静默删。
       只有人明确点「删除覆盖」才从本地表移除，而且必须再点「保存」才落库；确认文案写明 key 与后果。 */
    const ok = await confirmDialog(`删除项目 ${item.id} 的覆盖？该项目将回落到全局默认（当前 ${provider}）。`, { title: '删除项目覆盖', danger: true, okText: '删除' })
    if (!ok) return
    setOverrides(rows => rows.filter(row => row.id !== item.id))
    setNote({ status: 'dirty', text: `已从本地移除项目 ${item.id} 的覆盖，点「保存」后生效。` })
  }
  const save = async () => {
    setBusy(true); setNote(null)
    /* 永远发四字段 WeKnora + 完整 perProject 表：
       只发改动字段会踩「apiKey 留空 = 不修改」与「整表替换静默清掉别的项目」两个坑。 */
    const payload = {
      provider,
      weknora: { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), tenantId: tenantId.trim(), knowledgeBaseId: kb.trim() },
      perProject: Object.fromEntries(overrides.map(item => [item.id, item.provider])),
    }
    try {
      const out = await api('/config', { docs: payload })
      let readback = out?.state?.config?.docs
      if (readback === undefined || readback === null) readback = (await api('/state'))?.state?.config?.docs
      const diffs = diffDocsReadback(payload, readback, { apiKeySetBefore: weknora.apiKeySet === true })
      applyReadback(readback)
      await onChanged()
      if (diffs.length > 0) {
        setNote({ status: 'mismatch', text: `保存后回读不一致：${diffs.join('；')}` })
        return
      }
      setNote({ status: 'saved', text: '已保存' })
    } catch (cause) {
      /* 400 的结构化错误（哪个键错 / 缺什么 / 影响哪些范围）直接给原文，控件保留用户输入便于就地改。 */
      setNote({ status: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    } finally { setBusy(false) }
  }
  const addableProjects = projects.filter(item => !overrides.some(row => row.id === String(item.id ?? '')))
  const renderOverrideRow = item => {
    const known = projectOf(item.id)
    const archived = known?.status === 'archived'
    const name = known === undefined ? `未知项目（${item.id}）` : String(known.name ?? known.id ?? item.id)
    return h('div', {
      key: item.id, className: LISTROW,
      'data-perproject-row': true, 'data-perproject-id': item.id, 'data-perproject-value': item.provider,
      'data-perproject-known': known === undefined ? 'false' : 'true',
      'data-perproject-archived': archived ? 'true' : 'false',
    },
      h('div', { className: LISTROW_MAIN },
        h('div', { className: LISTROW_TITLE },
          h('span', { className: 'min-w-0 truncate' }, name),
          archived ? h('span', { className: HINT }, '已归档') : null,
          known === undefined ? h('span', { className: HINT, title: '这个项目已不在项目列表里，覆盖默认保留，不会被静默删掉' }, '项目列表里没有它') : null,
        ),
        h('div', { className: HINT }, item.id),
      ),
      h('div', { className: LISTROW_ACTIONS },
        h(SelectField, {
          size: 'sm',
          value: item.provider,
          'aria-label': `项目 ${name} 的出口`,
          onChange: event => {
            const next = event.target.value
            setOverrides(rows => (next === ''
              ? rows.filter(row => row.id !== item.id)
              : rows.map(row => (row.id === item.id ? { ...row, provider: next } : row))))
          },
        },
          h('option', { value: '' }, '跟随全局'),
          h('option', { value: 'feishu' }, '只写飞书云盘'),
          h('option', { value: 'weknora' }, '只写 WeKnora'),
          h('option', { value: 'both' }, '两个都写（飞书为主）'),
        ),
        known === undefined
          ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void removeUnknown(item) }, '删除覆盖')
          : null,
      ),
    )
  }
  /* 出口选择：以前是原生 <select>，现在走 SelectField（BoardUI 的
     react-aria Select）。探针靠面板根上的 data-docs-sink 读出口，不依赖控件长相。 */
  return h('div', { className: PANE, 'data-docs-sink': provider, 'data-panel': 'integrations-docs' },
    h('div', { className: SECTION, 'data-section': 'provider' },
      h('div', { className: SECTION_TITLE }, '文档出口'),
      h('div', { className: DESC }, '交付物永远以本地 artifact 为真源；这里只决定同步时投递到哪。both 时飞书为主，WeKnora 失败只记 error、不阻塞交付物登记。'),
      fieldOf(h, '出口',
        h(SelectField, {
          size: 'md',
          value: provider,
          'aria-label': '交付物投递出口',
          onChange: event => setProvider(event.target.value),
        },
          h('option', { value: 'feishu' }, '只写飞书云盘'),
          h('option', { value: 'weknora' }, '只写 WeKnora 知识库'),
          h('option', { value: 'both' }, '两个都写（飞书为主）'),
        )),
      fieldOf(h, 'WeKnora 地址',
        h(TextField, { value: baseUrl, placeholder: 'http://kb.example.com/api/v1', onChange: event => setBaseUrl(event.target.value) }),
        '带不带 /api/v1 都行；所有项目共用这一组 WeKnora 连接'),
      fieldOf(h, 'API Key',
        h(TextField, { type: 'password', autoComplete: 'new-password', 'aria-label': 'WeKnora API Key', value: apiKey, placeholder: weknora.apiKeySet ? '已配置（留空保持不变）' : 'sk-…', onChange: event => setApiKey(event.target.value) }),
        weknora.apiKeySet ? '已保存；留空保持不变，输入新值会覆盖' : '只需要 retrieve 能力；要跑问答再加 chat'),
      fieldOf(h, '租户 ID',
        h(TextField, { value: tenantId, placeholder: '10000', onChange: event => setTenantId(event.target.value) })),
      fieldOf(h, '知识库 ID',
        h(TextField, { value: kb, placeholder: 'deba6be0-…', onChange: event => setKb(event.target.value) }),
        '交付物会以 manual 文档写进这个库，并自动触发 reparse'),
    ),
    h('div', { className: SECTION, 'data-section': 'per-project' },
      h('div', { className: SECTION_TITLE }, '项目级覆盖'),
      h('div', { className: DESC }, '默认所有项目跟随全局出口。保存时提交完整表：删掉一行 = 该项目回落到全局默认；不在项目列表里的历史覆盖默认保留，不会被静默删掉。'),
      overrides.length === 0
        ? h(EmptyState, { title: '所有项目跟随全局默认。' })
        : h('div', { className: 'flex min-w-0 flex-col' }, overrides.map(renderOverrideRow)),
      h('div', { className: ROW },
        h(SelectField, {
          size: 'sm',
          value: addProject,
          'aria-label': '要覆盖的项目',
          onChange: event => setAddProject(event.target.value),
        },
          h('option', { value: '' }, addableProjects.length === 0 ? '所有项目都已覆盖' : '选择项目…'),
          addableProjects.map(item => h('option', { key: item.id, value: String(item.id) }, `${item.key ? `${item.key} · ` : ''}${item.name ?? item.id}${item.status === 'archived' ? '（已归档）' : ''}`)),
        ),
        h(SelectField, {
          size: 'sm',
          value: addProvider,
          'aria-label': '新覆盖的出口',
          onChange: event => setAddProvider(event.target.value),
        },
          h('option', { value: 'feishu' }, '只写飞书云盘'),
          h('option', { value: 'weknora' }, '只写 WeKnora'),
          h('option', { value: 'both' }, '两个都写（飞书为主）'),
        ),
        h(Button, {
          variant: 'secondary', size: 'sm', disabled: busy || addProject === '',
          onClick: () => {
            if (addProject === '') return
            setOverrides(rows => [...rows, { id: addProject, provider: addProvider }])
            setAddProject('')
          },
        }, '＋ 添加项目覆盖'),
      ),
    ),
    h('div', { className: ROW },
      h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: save, 'data-docs-save': true }, busy ? '保存中…' : '保存'),
      h('span', { className: HINT }, '保存后会用服务端回读的 config.docs 核对一遍，不一致不会显示「已保存」。'),
    ),
    note === null
      ? null
      : h('div', {
        className: note.status === 'saved' ? OK : note.status === 'error' || note.status === 'mismatch' ? ERR : HINT,
        role: 'status', 'data-docs-note': true, 'data-docs-status': note.status,
      }, note.text),
  )
}
