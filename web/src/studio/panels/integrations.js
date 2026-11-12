/* Settings panels lifted out of client.src.js; shared handles come from the studio context. */

import { client } from '../context.js'

export function ReposPanel({ config, onChanged }) {
  const { h, Editor, api, toast, confirmDialog, tipOf, TextField, ChipField, CheckField, MdField, SideDrawer , React } = client()
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

  const rows = projects.map(project => h('div', { className: 'ds-listrow', key: project.id },
    h('div', { className: 'ds-listrow-main' },
      h('div', {}, `${project.name || project.project}${project.syncEnabled ? ' · 自动同步' : ''}${project.tokenSet ? '' : ' · 缺令牌'}`),
      h('div', { className: 'ds-hint' }, `${project.url || config.gitlab.url || '（未填地址）'} / ${project.project}${project.lastSyncAt ? ' · 上次 ' + new Date(project.lastSyncAt).toLocaleString() : ''}`),
      project.lastSyncError ? h('div', { className: 'ds-error' }, project.lastSyncError) : null,
    ),
    h('div', { className: 'ds-listrow-actions' },
      h('button', { className: 'ds-btn', disabled: busy, onClick: () => void sync(project) }, '同步'),
      h('button', { className: 'ds-btn', disabled: busy, onClick: () => void test(project) }, '测试'),
      h('button', { className: 'ds-btn', disabled: busy, onClick: () => setDraft({ ...project, token: '' }) }, '编辑'),
      tipOf('删除这个项目（卡不会删）', h('button', { className: 'ds-btn', disabled: busy, onClick: () => void remove(project), 'data-danger': '1' }, '删除')),
    ),
  ))

  return h('div', { className: 'ds-pane-stack' },
    h(Editor, {
      title: '代码仓库（GitLab，可以有多个）',
      hint: '每个项目单独填地址、项目路径和令牌；同步时按项目分开去重，两个仓库都有 #12 也不会串。',
      rows, onAdd: () => setDraft({ id: '', name: '', url: config.gitlab?.url ?? '', project: '', token: '', syncEnabled: false, syncLabel: '' }), addLabel: '新增项目',
      render: row => row,
      empty: '还没有项目，点「新增项目」。',
    }),
    note !== null ? h('div', { className: 'ds-ok', style: { marginBottom: 8 } }, note) : null,
    draft === null ? null : h(SideDrawer, {
      title: draft.id ? `编辑仓库：${draft.name || draft.project}` : '新增仓库',
      hint: '一个仓库对应 GitLab 上的一个项目；令牌只写盘不回显，留空表示不修改。',
      onClose: () => setDraft(null),
      footer: [
        h('button', { key: 'save', className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
        h('button', { key: 'cancel', className: 'ds-btn', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: 'ds-error ds-side-note' }, error) : null,
      ],
    },
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '显示名'),
          h(TextField, { className: 'ds-input', value: draft.name, placeholder: '订单服务', onChange: e => set('name', e.target.value) }),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, 'GitLab 地址'),
          h(TextField, { className: 'ds-input', value: draft.url, placeholder: 'https://gitlab.example.com', onChange: e => set('url', e.target.value) }),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '项目路径（含 namespace）'),
          h(TextField, { className: 'ds-input', value: draft.project, placeholder: 'backend/order-service', onChange: e => set('project', e.target.value) }),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, draft.tokenSet ? 'Access Token（已设置，留空则不修改）' : 'Access Token'),
          h(TextField, {
            className: 'ds-input', type: 'password', value: draft.token,
            placeholder: draft.tokenSet ? '••••••••' : 'glpat-…',
            onChange: e => set('token', e.target.value),
          }),
          h('div', { className: 'ds-hint' }, '需要 api 权限；只写入磁盘，不回显。'),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '只同步带此标签的 Issue'),
          h(TextField, { className: 'ds-input', value: draft.syncLabel, placeholder: '留空则同步全部 open Issue', onChange: e => set('syncLabel', e.target.value) }),
        ),
        h('div', { className: 'ds-field' },
          h('label', { className: 'ds-row', style: { alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h(CheckField, { checked: draft.syncEnabled === true, onChange: e => set('syncEnabled', e.target.checked) }),
            h('span', {}, '每分钟自动把这个项目的新 Issue 拉成卡片'),
          ),
        ),
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
  const { h, Editor, api, toast, confirmDialog, tipOf, TextField, ChipField, CheckField, MdField, SideDrawer , React } = client()
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

  const rows = bots.map(bot => h('div', { className: 'ds-listrow', key: bot.id },
    h('div', { className: 'ds-listrow-main' },
      h('div', {}, `${bot.name}${bot.enabled === false ? ' （已停用）' : ''}${bot.webhookSet ? '' : ' · 缺 Webhook'}`),
      h('div', { className: 'ds-hint' }, `Webhook ${bot.webhookHint || '（未设置）'}${bot.chatId ? ' · 群 ' + bot.chatId : ''} · 收：${botEventNames(bot).join(' / ') || '什么都不收'}`),
    ),
    h('div', { className: 'ds-listrow-actions' },
      h('button', { className: 'ds-btn', disabled: busy, onClick: () => void test(bot) }, '测试'),
      h('button', { className: 'ds-btn', disabled: busy, onClick: () => setDraft({ ...bot, webhook: '' }) }, '编辑'),
      h('button', { className: 'ds-btn', disabled: busy, onClick: () => void remove(bot), 'data-danger': '1' }, '删除'),
    ),
  ))

  return h('div', { className: 'ds-pane-stack' },
    h(Editor, {
      title: '飞书机器人（可以有多个）',
      hint: '一个群建一个机器人，并在下面勾选它要收哪些事件；研发群只勾缺陷相关，产品群只勾版本发布。',
      rows, onAdd: () => setDraft({ id: '', name: '', webhook: '', chatId: '', notifyOnChange: true, events: { change: true, sla: true, bug: true, release: true }, enabled: true }), addLabel: '新增机器人',
      render: row => row,
      empty: '还没有机器人。',
    }),
    note !== null ? h('div', { className: 'ds-ok', style: { marginBottom: 8 } }, note) : null,
    h('div', { className: 'ds-panel ds-form-panel' },
      h('div', { className: 'ds-panel-head' }, '云盘归档（产物文档）'),
      h('div', { className: 'ds-panel-body' },
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '云盘根文件夹 token 或链接'),
          h(TextField, {
            className: 'ds-input', value: driveFolder, placeholder: 'IuJPfTCtWlDrzwdCFmLc71aynbg 或文件夹链接',
            onChange: e => setDriveFolder(e.target.value),
          }),
          h('div', { className: 'ds-hint' }, `每条需求会在它下面建一个「编号 + 标题」的同名文件夹，交付物写成文件夹里的一份 .md 文档。飞书授权：${config.feishu?.larkReady ? 'lark-cli 已就绪' : 'lark-cli 未就绪或未授权'}`),
        ),
        h('label', { className: 'ds-row', style: { alignItems: 'center', gap: 8, cursor: 'pointer' } },
          h(CheckField, { checked: autoSync, onChange: e => setAutoSync(e.target.checked) }),
          h('span', {}, '专家登记交付物时自动归档（关掉就只存平台里）'),
        ),
        h('div', { className: 'ds-row', style: { gap: 8 } },
          h('button', { className: 'ds-btn ds-btn-primary', disabled: driveBusy, onClick: () => void saveDrive() }, driveBusy ? '保存中…' : '保存'),
          driveNote !== null ? h('div', { className: 'ds-hint' }, driveNote) : null,
        ),
      ),
    ),
    draft === null ? null : h(SideDrawer, {
      title: draft.id ? `编辑机器人：${draft.name || draft.id}` : '新增机器人',
      hint: 'Webhook 只写盘不回显，留空表示不修改；一个群建一个机器人即可。',
      onClose: () => setDraft(null),
      footer: [
        h('button', { key: 'save', className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
        h('button', { key: 'cancel', className: 'ds-btn', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: 'ds-error ds-side-note' }, error) : null,
      ],
    },
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '名字'),
          h(TextField, { className: 'ds-input', value: draft.name, placeholder: '研发群通知', onChange: e => set('name', e.target.value) }),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, draft.webhookSet ? 'Webhook（已设置，留空则不修改）' : 'Webhook'),
          h(TextField, {
            className: 'ds-input', type: 'password', value: draft.webhook,
            placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
            onChange: e => set('webhook', e.target.value),
          }),
          h('div', { className: 'ds-hint' }, '在飞书群里「添加机器人 → 自定义机器人」即可拿到，不需要自建应用。'),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '备注群 chat_id（可选）'),
          h(TextField, { className: 'ds-input', value: draft.chatId, placeholder: 'oc_…', onChange: e => set('chatId', e.target.value) }),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '收哪些事件'),
          h('div', { className: 'ds-row', style: { gap: 16, flexWrap: 'wrap' } },
            ...BOT_EVENTS.map(item => h('label', { key: item.key, className: 'ds-row', style: { alignItems: 'center', gap: 8, cursor: 'pointer' } },
              h(CheckField, {
                checked: eventOn(item.key),
                onChange: e => setEvent(item.key, e.target.checked),
              }),
              h('span', {}, item.label),
            )),
          ),
          h('div', { className: 'ds-hint' }, '不勾任何一项就等于这个群静默（只保留测试消息）。'),
        ),
        h('div', { className: 'ds-row', style: { gap: 16 } },
          h('label', { className: 'ds-row', style: { alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h(CheckField, { checked: draft.enabled !== false, onChange: e => set('enabled', e.target.checked) }),
            h('span', {}, '启用'),
          ),
        ),
    ),
  )
}

export function SkillsPanel({ config, onChanged }) {
  const { h, Editor, api, toast, confirmDialog, tipOf, TextField, ChipField, CheckField, MdField, SideDrawer , React } = client()
  const [data, setData] = React.useState(null)
  const [draft, setDraft] = React.useState(null)
  const [error, setError] = React.useState(null)
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

  const rows = skills.map(skill => h('div', { className: 'ds-listrow', key: skill.name },
    h('div', { className: 'ds-listrow-main' },
      h('div', {},
        h('code', {}, skill.name),
        (skill.tags ?? []).map(tag => h(ChipField, { className: 'ds-chip', key: tag }, tag)),
        skill.enabled === false ? h('span', { className: 'ds-hint' }, ' （已停用）') : null,
        onDisk.includes(skill.name) ? null : h('span', { className: 'ds-err' }, ' 未落盘'),
      ),
      h('div', { className: 'ds-hint' }, skill.description),
      skill.whenToUse ? h('div', { className: 'ds-hint' }, `何时用：${skill.whenToUse}`) : null,
      users(skill.name).length > 0
        ? h('div', { className: 'ds-hint' }, `使用中的专家：${users(skill.name).map(expert => `${expert.emoji}${expert.name}`).join('、')}`)
        : h('div', { className: 'ds-empty' }, '还没有专家挂这个技能'),
    ),
    h('div', { className: 'ds-listrow-actions' },
      h('button', { className: 'ds-btn', disabled: busy, onClick: () => { setNote(null); setDraft({ ...skill, editing: true, tags: (skill.tags ?? []).join(', ') }) } }, '编辑'),
      h('button', { className: 'ds-btn', disabled: busy, onClick: () => void remove(skill), 'data-danger': '1' }, '删除'),
    ),
  ))

  const stray = onDisk.filter(name => !skills.some(skill => skill.name === name))

  return h('div', { className: 'ds-pane-stack' },
    h(Editor, {
      title: '技能库（skills-manager）',
      hint: data === null ? '读取中…' : `保存在 ${data.root}/<名字>/SKILL.md，所有专家都能用 skill 工具加载；专家也可以自己用 studio_skill_save 往这里加技能。支持上传 SKILL.md 或包含 SKILL.md 的 .zip 技能包。`,
      rows, addLabel: '新建技能',
      onAdd: () => { setNote(null); setDraft({ name: '', description: '', whenToUse: '', tags: '', content: '# 什么时候用\n\n# 步骤\n\n1. \n', enabled: true, editing: false }) },
      render: row => row,
      empty: '还没有技能。把一次摸索出来的做法写成第一条，下次就不用重新摸索。',
    }),
    stray.length > 0
      ? h('div', { className: 'ds-hint' }, `磁盘上还有 ${stray.length} 个不归这里管的技能目录：${stray.join('、')}`)
      : null,
    h('div', { className: 'ds-row', style: { gap: 8, alignItems: 'center', padding: '6px 0 10px', flexWrap: 'wrap' } },
      h('label', { className: 'ds-btn', style: { cursor: uploading ? 'progress' : 'pointer', opacity: uploading ? 0.6 : 1 } },
        uploading ? '上传中…' : '上传技能',
        h('input', {
          type: 'file', accept: '.md,.markdown,.txt,.zip', style: { display: 'none' }, disabled: uploading,
          onChange: event => { const file = event.target.files === null ? undefined : event.target.files[0]; event.target.value = ''; void upload(file) },
        }),
      ),
      h('label', { className: 'ds-hint', style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
        h(CheckField, { checked: overwrite, onChange: event => setOverwrite(event.target.checked) }),
        '覆盖同名技能',
      ),
      h('button', { className: 'ds-btn', disabled: busy || skills.length === 0, onClick: () => void resync() }, '重新写入磁盘'),
      note !== null ? h('span', { className: 'ds-ok' }, note) : null,
      error !== null ? h('span', { className: 'ds-error' }, error) : null,
    ),
    draft === null ? null : h(SideDrawer, {
      title: draft.editing === true ? `编辑技能：${draft.name}` : '新建技能',
      hint: '技能正文就是一个 SKILL.md：什么情况用、步骤、命令、踩过的坑。保存后写入 ~/.dsh/skills/<名字>/SKILL.md。',
      onClose: () => setDraft(null),
      footer: [
        h('button', { key: 'save', className: 'ds-btn ds-btn-primary', disabled: busy || draft.name.length === 0 || draft.content.trim().length === 0, onClick: () => void save() }, busy ? '保存中…' : '保存技能'),
        h('button', { key: 'cancel', className: 'ds-btn', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: 'ds-error ds-side-note' }, error) : null,
      ],
    },
        h('div', { className: 'ds-row', style: { gap: 8 } },
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '技能名（kebab-case）'),
            h(TextField, {
              className: 'ds-input', value: draft.name, disabled: draft.editing === true,
              placeholder: 'gitlab-mr-review',
              onChange: e => set('name', e.target.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')),
            }),
          ),
          h('div', { className: 'ds-field', style: { flex: 2 } },
            h('div', { className: 'ds-label' }, '什么时候该用（一行，模型据此决定要不要加载）'),
            h(TextField, { className: 'ds-input', value: draft.description, placeholder: '评审 GitLab MR 时：怎么读 diff、怎么留评论', onChange: e => set('description', e.target.value) }),
          ),
        ),
        h('div', { className: 'ds-row', style: { gap: 8 } },
          h('div', { className: 'ds-field', style: { flex: 2 } },
            h('div', { className: 'ds-label' }, '补充触发条件（选填）'),
            h(TextField, { className: 'ds-input', value: draft.whenToUse, placeholder: '收到 @研发 且带 MR 链接时', onChange: e => set('whenToUse', e.target.value) }),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '标签（逗号分隔）'),
            h(TextField, { className: 'ds-input', value: draft.tags, placeholder: 'gitlab, review', onChange: e => set('tags', e.target.value) }),
          ),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '技能正文（Markdown：什么情况用、步骤、命令、坑）'),
          h(MdField, {
            className: 'ds-input', rows: 14, value: draft.content,
            placeholder: '# 什么时候用\n\n# 步骤\n\n1. \n\n# 坑\n\n- ',
            onChange: e => set('content', e.target.value),
          }),
        ),
        h('div', { className: 'ds-field' },
          h('label', { className: 'ds-row', style: { alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h(CheckField, { checked: draft.enabled !== false, onChange: e => set('enabled', e.target.checked) }),
            h('span', {}, '启用（停用则不写入磁盘）'),
          ),
        ),
    ),
  )
}
