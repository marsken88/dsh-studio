/* Settings panels lifted out of client.src.js; shared handles come from the studio context. */

import { ROLE_LABEL } from '../labels.js'
import { client } from '../context.js'

export function ExpertsPanel({ config, onChanged }) {
  const { h, React, Editor, api, toast, confirmDialog, tipOf, tipLabel, TextField, TextAreaField, ChipField, CheckField, SelectField, SideDrawer } = client()
  const experts = config.experts ?? []
  const [draft, setDraft] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const EMOJI_CHOICES = [
    '🧩', '📋', '🏛️', '🛠️', '🧪', '🔍', '🛡️', '⚙️',
    '📦', '💰', '💳', '📊', '📈', '🧠', '🤖', '🧭',
    '🎯', '🚀', '🧱', '🔧', '🧰', '🧮', '📝', '📚',
    '🗂️', '🔐', '🌐', '☁️', '🗄️', '🧬', '🩺', '⚖️',
  ]

  const save = async () => {
    if (draft === null) return
    setBusy(true); setError(null)
    try { await api('/experts/save', { expert: draft }); setDraft(null); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const remove = async expert => {
    if (!(await confirmDialog(`删除专家「${expert.name}」？已用它派的单会保留历史评论。`, { title: '删除专家', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null)
    try { await api('/experts/delete', { id: expert.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const set = (key, value) => setDraft({ ...draft, [key]: value })
  const [batchDomain, setBatchDomain] = React.useState('')
  const [library, setLibrary] = React.useState([])
  React.useEffect(() => {
    let alive = true
    void api('/skills').then(payload => { if (alive) setLibrary(payload.skills ?? []) }).catch(() => {})
    return () => { alive = false }
  }, [])
  const toggleSkill = name => {
    const current = draft.skills ?? []
    set('skills', current.includes(name) ? current.filter(entry => entry !== name) : [...current, name])
  }
  const [skillInput, setSkillInput] = React.useState('')
  const addSkillName = () => {
    const value = skillInput.trim()
    if (value === '' || draft === null) return
    const current = draft.skills ?? []
    if (!current.includes(value)) set('skills', [...current, value])
    setSkillInput('')
  }
  const createDomainSet = async () => {
    const domain = batchDomain.trim()
    if (domain.length === 0) return
    setBusy(true); setError(null)
    try {
      const roles = [
        { role: 'product', name: '产品经理', emoji: '📋', prompt: `你是${domain}业务的产品经理。\n先读 docs/ 与本领域的历史工单，再动手。\n需求写清：目标用户、主流程、异常路径、验收口径。` },
        { role: 'architect', name: '架构师', emoji: '🏛️', prompt: `你是${domain}业务的架构师。\n方案必须给出：数据模型、接口契约、失败与回滚、性能与容量估算。\n不确定就去代码里找证据。` },
        { role: 'dev', name: '开发工程师', emoji: '🛠️', prompt: `你是${domain}业务的开发工程师。\n改动要小步可验证，跑测试，写清改动的文件与风险。` },
        { role: 'qa', name: '测试工程师', emoji: '🧪', prompt: `你是${domain}业务的测试工程师。\n按边界值、异常流、并发与幂等设计用例，列出实际执行结果。` },
      ]
      for (const role of roles) {
        await api('/experts/save', {
          expert: {
            name: `${domain}${role.name}`,
            emoji: role.emoji,
            role: role.role,
            domain,
            description: `负责${domain}业务线的${role.name}工作`,
            prompt: role.prompt,
            model: '', preset: '', enabled: true,
          },
        })
      }
      setBatchDomain('')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const promptPreview = text => {
    const value = String(text ?? '').trim()
    if (value === '') return ''
    const compact = value.replace(/\s*\n\s*/g, ' / ')
    return compact.length > 96 ? `${compact.slice(0, 96)}…` : compact
  }
  const rows = experts.map(expert => h('div', { className: 'ds-listrow', key: expert.id },
    h('div', { className: 'ds-listrow-main' },
      h('div', {}, `${expert.emoji} ${expert.name}`,
        expert.domain ? h(ChipField, { className: 'ds-chip' }, expert.domain) : null,
        expert.enabled === false ? h('span', { className: 'ds-hint' }, ' （已停用）') : null),
      h('div', { className: 'ds-hint' }, `${expert.model || '跟随默认模型'}${expert.description ? ' · ' + expert.description : ''}`),
      promptPreview(expert.prompt) === ''
        ? h('div', { className: 'ds-hint', 'data-empty': '1' }, '提示词：还没有写，会退回内置角色说明（点「编辑」补上）')
        : h('div', {
            className: 'ds-hint',
            'data-prompt': '1',
            title: String(expert.prompt ?? ''),
            style: { cursor: 'pointer' },
            onClick: () => setDraft({ ...expert }),
          }, `提示词：${promptPreview(expert.prompt)}`),
      (expert.skills ?? []).length > 0 ? h('div', { className: 'ds-hint' }, `技能：${expert.skills.join('、')}`) : null,
    ),
    h('div', { className: 'ds-listrow-actions' },
      tipOf('编辑这位专家', h('button', { className: 'ds-btn', disabled: busy, onClick: () => setDraft({ ...expert }) }, '编辑')),
      tipOf('删除这位专家', h('button', { className: 'ds-btn', disabled: busy, onClick: () => void remove(expert), 'data-danger': '1' }, '删除')),
    ),
  ))

  return h('div', { className: 'ds-pane-stack' },
    h(Editor, {
      title: '专家（可在评论里 @ 他们）',
      hint: '每个专家有名字、业务领域、角色提示词和技能；评论里 @名字 就会把这条工作派给他。',
      rows, onAdd: () => setDraft({ id: '', name: '', emoji: '🧩', role: '', domain: '', description: '', prompt: '', skills: [], model: '', preset: '', sandbox: '', enabled: true }), addLabel: '新增专家',
      render: row => row,
      empty: '还没有专家，点「新增专家」建一个。',
    }),
    h('div', { className: 'ds-row', style: { gap: 8, alignItems: 'center', padding: '6px 0 10px' } },
      h('span', { className: 'ds-hint' }, '按业务领域一次生成四位：'),
      h(TextField, {
        className: 'ds-input', style: { maxWidth: 180 }, value: batchDomain, placeholder: '支付 / 风控 / 会员',
        onChange: e => setBatchDomain(e.target.value),
      }),
      h('button', { className: 'ds-btn', disabled: busy || batchDomain.trim().length === 0, onClick: () => void createDomainSet() }, '生成产品/架构/研发/测试'),
      error !== null ? h('span', { className: 'ds-error' }, error) : null,
    ),
    draft === null ? null : h(SideDrawer, {
      title: draft.id ? `编辑专家：${draft.name || draft.id}` : '新增专家',
      hint: '技能与提示词会随下一次派活生效，改完点右下角「保存」。',
      onClose: () => setDraft(null),
      footer: [
        h('button', { key: 'save', className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
        h('button', { key: 'cancel', className: 'ds-btn', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: 'ds-error ds-side-note' }, error) : null,
      ],
    },
        h('div', { className: 'ds-row', style: { gap: 12, alignItems: 'flex-start' } },
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '名字（@ 用这个名字）'),
            h(TextField, { className: 'ds-input', value: draft.name, placeholder: '安全专家', onChange: e => set('name', e.target.value) }),
          ),
          h('div', { className: 'ds-field', style: { flex: '0 0 96px' } },
            h('div', { className: 'ds-label' }, '当前图标'),
            h('div', { className: 'ds-emoji-preview' }, draft.emoji || '🧩'),
          ),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '图标（点一个换上，也可以自己填）'),
          h('div', { className: 'ds-emojigrid' },
            EMOJI_CHOICES.map(face => h('button', {
              key: face, type: 'button', className: 'ds-emoji', 'data-on': draft.emoji === face ? '1' : '0',
              title: face, onClick: () => set('emoji', face),
            }, face)),
          ),
          h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8, alignItems: 'center' } },
            h(TextField, {
              className: 'ds-input', style: { flex: '0 0 120px' }, value: draft.emoji, maxLength: 4,
              placeholder: '🧩',
              onChange: e => set('emoji', e.target.value),
            }),
            h('span', { className: 'ds-hint' }, '也可以粘一个 emoji，或者留空用默认的 🧩。'),
          ),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '一句话定位'),
          h(TextField, { className: 'ds-input', value: draft.description, placeholder: '负责接口安全与权限模型评审', onChange: e => set('description', e.target.value) }),
        ),
        h('div', { className: 'ds-row', style: { gap: 12, alignItems: 'flex-start' } },
          h('div', { className: 'ds-field', style: { flex: '0 0 132px' } },
            tipLabel('角色位', '决定它对应看板上的哪一列；列负责人按角色位挑人时用得上'),
            h(SelectField, {
              className: 'ds-select', value: draft.role ?? '',
              onChange: e => set('role', e.target.value),
            },
              h('option', { value: '' }, '不限'),
              ['product', 'architect', 'dev', 'qa'].map(v => h('option', { key: v, value: v }, ROLE_LABEL[v] ?? v))),
            h('div', { className: 'ds-hint' }, '决定默认接哪一列'),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            tipLabel('业务领域', '「按专长匹配」看这里：领域相同的卡优先派给它'),
            h(TextField, { className: 'ds-input', value: draft.domain ?? '', placeholder: '支付 / 风控 / 会员（选填）', onChange: e => set('domain', e.target.value) }),
            h('div', { className: 'ds-hint' }, '同一张卡会优先派给同领域的专家'),
          ),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, `技能（从技能库勾选 · 已选 ${(draft.skills ?? []).length} 项）`),
          library.length > 0
            ? h('div', { className: 'ds-skillbox' },
              library.map(skill => {
                const on = (draft.skills ?? []).includes(skill.name)
                const users = experts.filter(item => (item.skills ?? []).includes(skill.name)).length
                return h('label', { key: skill.name, className: 'ds-skillopt', 'data-on': on ? '1' : '0', title: String(skill.description ?? '') },
                  h(CheckField, { checked: on, onChange: () => toggleSkill(skill.name) }),
                  h('span', { className: 'ds-skillname' }, skill.name),
                  h('span', { className: 'ds-skilldesc' }, String(skill.description ?? '').slice(0, 46)),
                  users > 0 ? h('span', { className: 'ds-skillusers' }, `${users} 位在用`) : null,
                )
              }),
            )
            : h('div', { className: 'ds-hint' }, '技能库还是空的，去「技能库」建一条，或者在下面直接写名字。'),
          h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8, alignItems: 'center' } },
            h(TextField, {
              className: 'ds-input', style: { flex: 1 }, value: skillInput,
              placeholder: '技能库以外的技能名，例如 lark-doc、office-xlsx（回车或点「加上」）',
              onChange: e => setSkillInput(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); addSkillName() } },
            }),
            h('button', { className: 'ds-btn', onClick: () => addSkillName() }, '加上'),
          ),
          (draft.skills ?? []).filter(name => !library.some(skill => skill.name === name)).length > 0
            ? h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' } },
              h('span', { className: 'ds-hint' }, '不在技能库（仍会写进提示词）：'),
              (draft.skills ?? []).filter(name => !library.some(skill => skill.name === name)).map(name => h(ChipField, { key: name, className: 'ds-chip', 'data-missing': '1' },
                name,
                h('button', { className: 'ds-chip-x', title: '移除', onClick: () => set('skills', (draft.skills ?? []).filter(entry => entry !== name)) }, '×'),
              )),
            )
            : null,
        ),
        h('div', { className: 'ds-row', style: { gap: 8 } },
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '模型'),
            h(TextField, { className: 'ds-input', value: draft.model, placeholder: 'deepseek-v4.1-flash（留空跟随角色默认）', onChange: e => set('model', e.target.value) }),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            tipLabel('Agent 预设', '预设决定这个专家能用哪些工具、以什么身份干活（如 standard、架构师）'),
            h(TextField, { className: 'ds-input', value: draft.preset, placeholder: 'standard', onChange: e => set('preset', e.target.value) }),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            tipLabel('沙箱档位', 'read-only 只能看；workspace-write 能改工作区；danger-full-access 不做限制'),
            h(SelectField, {
              className: 'ds-input',
              value: draft.sandbox ?? '',
              onChange: e => set('sandbox', e.target.value),
            },
              [['', '跟随全局'],
                ['read-only', '只读'],
                ['workspace-write', '只写工作区'],
                ['danger-full-access', '无沙箱']].map(([id, label]) =>
                h('option', { key: id, value: id }, label)),
            ),
            h('div', { className: 'ds-hint' }, '研发/测试这类要真跑命令的专家建议「只写工作区」。'),
          ),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '角色提示词（每次派活都会作为系统提示发给这个专家）'),
          h(TextAreaField, {
            className: 'ds-input', rows: 9, value: draft.prompt,
            placeholder: '例如：\n你是支付域的产品经理。先读 docs/ 与支付相关的 ADR，再动手。\n需求必须写清：目标用户、主流程、异常与退款路径、对账口径。\n不确定的地方去代码或历史工单里找证据，禁止编造接口字段。',
            onChange: e => set('prompt', e.target.value),
          }),
        ),
        h('div', { className: 'ds-field' },
          h('label', { className: 'ds-row', style: { alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h(CheckField, { checked: draft.enabled !== false, onChange: e => set('enabled', e.target.checked) }),
            h('span', {}, '启用这个专家'),
          ),
        ),
    ),
  )
}

export function TeamsPanel({ config, onChanged }) {
  const { h, React, Editor, api, toast, confirmDialog, tipOf, tipLabel, TextField, TextAreaField, ChipField, CheckField, SelectField, SideDrawer } = client()
  const teams = config.teams ?? []
  const experts = config.experts ?? []
  const [draft, setDraft] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const nameOf = id => {
    const found = experts.find(expert => expert.id === id)
    return found === undefined ? id : `${found.emoji} ${found.name}`
  }
  const save = async () => {
    if (draft === null) return
    setBusy(true); setError(null)
    try { await api('/teams/save', { team: draft }); setDraft(null); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const remove = async team => {
    if (!(await confirmDialog(`删除专家团「${team.name}」？`, { title: '删除专家团', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null)
    try { await api('/teams/delete', { id: team.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const set = (key, value) => setDraft({ ...draft, [key]: value })

  const rows = teams.map(team => h('div', { className: 'ds-listrow', key: team.id },
    h('div', { className: 'ds-listrow-main' },
      h('div', {}, `👥 ${team.name}`),
      h('div', { className: 'ds-hint' }, `团长 ${nameOf(team.lead)} · 成员 ${team.members.map(nameOf).join('、')}`),
    ),
    h('div', { className: 'ds-listrow-actions' },
      tipOf('编辑这个专家团', h('button', { className: 'ds-btn', disabled: busy, onClick: () => setDraft({ ...team }) }, '编辑')),
      tipOf('删除这个专家团', h('button', { className: 'ds-btn', disabled: busy, onClick: () => void remove(team), 'data-danger': '1' }, '删除')),
    ),
  ))

  return h('div', { className: 'ds-pane-stack' },
    h(Editor, {
      title: '专家团（一起干活）',
      hint: '专家团有团长和成员。评论里 @团名，团长会拆活、给成员派活并汇总结论；成员之间可以继续 @ 接棒。',
      rows, onAdd: () => setDraft({ id: '', name: '', description: '', members: [], lead: '', enabled: true }), addLabel: '新增专家团',
      render: row => row,
      empty: '还没有专家团。',
    }),
    draft === null ? null : h(SideDrawer, {
      title: draft.id ? `编辑专家团：${draft.name || draft.id}` : '新增专家团',
      hint: '团长负责拆活，成员之间在评论里用 @名字 接棒；改完点右下角「保存」。',
      onClose: () => setDraft(null),
      footer: [
        h('button', { key: 'save', className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
        h('button', { key: 'cancel', className: 'ds-btn', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: 'ds-error ds-side-note' }, error) : null,
      ],
    },
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '团名（@ 用这个名字）'),
          h(TextField, { className: 'ds-input', value: draft.name, placeholder: '需求交付组', onChange: e => set('name', e.target.value) }),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '这个团负责什么'),
          h(TextField, { className: 'ds-input', value: draft.description, placeholder: '从需求澄清一路做到验收', onChange: e => set('description', e.target.value) }),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '成员'),
          experts.length === 0 ? h('div', { className: 'ds-hint' }, '先去上面建几个专家。') : h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 12 } },
            experts.map(expert => h('label', { className: 'ds-row', key: expert.id, style: { alignItems: 'center', gap: 6, cursor: 'pointer' } },
              h(CheckField, { checked: (draft.members ?? []).includes(expert.id),
                onChange: e => set('members', e.target.checked
                  ? [...(draft.members ?? []), expert.id]
                  : (draft.members ?? []).filter(id => id !== expert.id)),
              }),
              h('span', {}, `${expert.emoji} ${expert.name}`),
            )),
          ),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '团长（负责拆活和汇总）'),
          h(SelectField, {
            className: 'ds-input', value: draft.lead ?? '',
            onChange: e => set('lead', e.target.value),
          },
            h('option', { value: '' }, '自动（第一个成员）'),
            (draft.members ?? []).map(id => h('option', { key: id, value: id }, nameOf(id))),
          ),
        ),
    ),
  )
}

export function TestingPanel({ config, onChanged }) {
  const { h, React, Editor, api, toast, confirmDialog, tipOf, tipLabel, TextField, TextAreaField, ChipField, CheckField, SelectField, SideDrawer } = client()
  const testing = config.testing ?? {}
  const envs = Array.isArray(testing.envs) ? testing.envs : []
  const [draft, setDraft] = React.useState(null)
  const [hosts, setHosts] = React.useState((Array.isArray(testing.allowHosts) ? testing.allowHosts : []).join(', '))
  const [timeoutText, setTimeoutText] = React.useState(String(testing.timeoutMs ?? 15000))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [note, setNote] = React.useState(null)

  const push = async next => {
    setBusy(true); setError(null); setNote(null)
    try {
      await api('/config', {
        testing: {
          envs: next.envs ?? envs,
          defaultEnv: next.defaultEnv !== undefined ? next.defaultEnv : (testing.defaultEnv ?? ''),
          timeoutMs: next.timeoutMs !== undefined ? next.timeoutMs : (testing.timeoutMs ?? 15000),
          allowHosts: next.allowHosts !== undefined ? next.allowHosts : (Array.isArray(testing.allowHosts) ? testing.allowHosts : []),
          concurrency: testing.concurrency ?? 4,
        },
      })
      setNote('已保存'); toast('已保存')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const saveEnv = async () => {
    if (draft === null) return
    const name = String(draft.name ?? '').trim()
    const baseUrl = String(draft.baseUrl ?? '').trim()
    if (name === '') { setError('环境名不能为空'); return }
    const entry = { id: draft.id ?? '', name, baseUrl }
    const next = draft.id === undefined || draft.id === ''
      ? [...envs, entry]
      : envs.map(item => (item.id === draft.id ? { ...item, ...entry } : item))
    setDraft(null)
    await push({ envs: next, defaultEnv: testing.defaultEnv === '' ? '' : testing.defaultEnv })
  }
  const removeEnv = async env => {
    if (!(await confirmDialog(`删除环境「${env.name}」？`, { title: '删除环境', danger: true, okText: '删除' }))) return
    const next = envs.filter(item => item.id !== env.id)
    await push({ envs: next, defaultEnv: testing.defaultEnv === env.id ? (next[0]?.id ?? '') : testing.defaultEnv })
  }
  const saveHosts = async () => {
    const list = hosts.split(/[,，\s]+/).map(item => item.trim()).filter(item => item !== '')
    const ms = Number(timeoutText)
    await push({ allowHosts: list, timeoutMs: Number.isFinite(ms) && ms > 0 ? ms : 15000 })
  }

  const envRow = env => h('div', { key: env.id, className: 'ds-listrow' },
    h('div', { className: 'ds-listrow-main' },
      h('div', null, `${env.name}${testing.defaultEnv === env.id ? ' · 默认' : ''}`),
      h('div', { className: 'ds-hint' }, env.baseUrl === '' ? '相对地址会因为没有 baseUrl 而失败' : env.baseUrl),
    ),
    h('div', { className: 'ds-listrow-actions' },
      testing.defaultEnv === env.id ? null : h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void push({ defaultEnv: env.id }) }, '设为默认'),
      h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => setDraft({ ...env }) }, '编辑'),
      h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void removeEnv(env), 'data-danger': '1' }, '删除'),
    ),
  )

  const form = draft === null ? null : h('div', { className: 'ds-panel ds-form-panel' },
    h('div', { className: 'ds-panel-head' }, draft.id === undefined || draft.id === '' ? '新增环境' : `编辑环境：${draft.name}`),
    h('div', { className: 'ds-panel-body' },
      h('div', { className: 'ds-field' },
        h('div', { className: 'ds-label' }, '环境名'),
        h(TextField, { className: 'ds-input', value: draft.name ?? '', placeholder: '例如 测试环境 / 预发环境', onChange: event => setDraft({ ...draft, name: event.target.value }) }),
      ),
      h('div', { className: 'ds-field' },
        tipLabel('baseUrl', '接口测试的根地址，用例里的 /path 会拼在它后面'),
        h(TextField, { className: 'ds-input', value: draft.baseUrl ?? '', placeholder: 'https://test.example.com', onChange: event => setDraft({ ...draft, baseUrl: event.target.value }) }),
      ),
      h('div', { className: 'ds-row', style: { justifyContent: 'flex-end' } },
        h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void saveEnv() }, '保存环境'),
      ),
    ),
  )

  return h('div', { className: 'ds-pane-stack' },
    form,
    h('div', { className: 'ds-panel' },
      h('div', { className: 'ds-panel-head' }, '测试环境',
        h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => setDraft({ name: '', baseUrl: '' }) }, '＋ 新增环境')),
      h('div', { className: 'ds-panel-body' },
        envs.length === 0 ? h('div', { className: 'ds-empty' }, '还没有环境。接口用例里的相对地址会拼到这里配置的 baseUrl。') : envs.map(envRow),
      ),
    ),
    h('div', { className: 'ds-panel ds-form-panel' },
      h('div', { className: 'ds-panel-head' }, '执行约束'),
      h('div', { className: 'ds-panel-body' },
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '允许访问的域名（逗号分隔，支持 *.example.com）'),
          h(TextField, { className: 'ds-input', value: hosts, placeholder: '127.0.0.1, localhost, test.example.com', onChange: event => setHosts(event.target.value) }),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '单条用例超时（毫秒）'),
          h(TextField, { className: 'ds-input', value: timeoutText, onChange: event => setTimeoutText(event.target.value) }),
        ),
        h('div', { className: 'ds-row', style: { justifyContent: 'flex-end' } },
          h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void saveHosts() }, busy ? '保存中…' : '保存约束'),
        ),
        note === null ? null : h('div', { className: 'ds-ok' }, note),
        error === null ? null : h('div', { className: 'ds-err' }, error),
      ),
    ),
  )
}

/** 通知升级：通道连续失败达到阈值时，往另一个群发一条，别和日常通知混在一起。 */
export function EscalatePanel({ config, onChanged }) {
  const { h, React, Editor, api, toast, confirmDialog, tipOf, tipLabel, TextField, TextAreaField, ChipField, CheckField, SelectField, SideDrawer } = client()
  const feishu = config.feishu ?? {}
  const [hook, setHook] = React.useState('')
  const [after, setAfter] = React.useState(String(feishu.escalateAfter ?? 3))
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState(null)
  const [error, setError] = React.useState(null)
  const save = async () => {
    setBusy(true); setNote(null); setError(null)
    try {
      const payload = {}
      if (String(hook ?? '').trim() !== '') payload.escalateWebhook = String(hook).trim()
      payload.escalateAfter = Number(after) || 3
      await api('/config', { feishu: payload })
      setHook('')
      setNote('已保存：连续失败 ' + (Number(after) || 3) + ' 次后往升级群发一条')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  return h('div', { className: 'ds-panel ds-form-panel', style: { marginTop: 14 } },
    h('div', { className: 'ds-panel-head' }, '通知升级'),
    h('div', { className: 'ds-panel-body' },
      h('div', { className: 'ds-field' },
        h('div', { className: 'ds-label' }, '升级群 Webhook'),
        h(TextField, {
          className: 'ds-input', value: hook,
          placeholder: feishu.escalateWebhookSet === true ? '已设置（留空表示不修改）' : 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
          onChange: event => setHook(event.target.value),
        }),
      ),
      h('div', { className: 'ds-field' },
        tipLabel('连续失败几次后升级', '同一通道连续失败到这个次数，就给升级群发消息'),
        h(TextField, { className: 'ds-input', style: { width: 90 }, value: after, onChange: event => setAfter(event.target.value) }),
      ),
      h('div', { className: 'ds-hint' }, '飞书通知、GitLab、云盘归档、代码隔离任一通道连续失败达到阈值时，只在跨过阈值那一次往升级群发一条，包含通道、失败次数与最近错误。'),
      h('div', { className: 'ds-row', style: { justifyContent: 'flex-end' } },
        h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存升级设置'),
      ),
      note === null ? null : h('div', { className: 'ds-ok' }, note),
      error === null ? null : h('div', { className: 'ds-err' }, error),
    ),
  )
}

/** 部署环境：只用于登记「版本上过哪个环境」，平台不触发任何部署。 */
export function EnvironmentsPanel({ config, onChanged }) {
  const { h, React, Editor, api, toast, confirmDialog, tipOf, tipLabel, TextField, TextAreaField, ChipField, CheckField, SelectField, SideDrawer } = client()
  const [rows, setRows] = React.useState(() => (config.environments ?? []).map(env => ({ id: env.id, name: env.name, kind: env.kind, note: env.note })))
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [rulesNote, setRulesNote] = React.useState(null)
  const saveRules = async patch => {
    setRulesNote(null)
    try {
      await api('/config', { releaseRules: patch })
      setRulesNote('发布准入已更新')
      await onChanged()
    } catch (cause) {
      setRulesNote(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const addRow = () => setRows(list => (list.length >= 12 ? list : [...list, { id: '', name: '', kind: 'other', note: '' }]))
  const setRow = (index, patch) => setRows(list => list.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const dropRow = index => setRows(list => list.filter((row, i) => i !== index))
  const save = async () => {
    setBusy(true); setNote(null); setError(null)
    try {
      const payload = rows
        .map(row => ({ ...row, name: String(row.name ?? '').trim() }))
        .filter(row => row.name !== '')
      if (payload.length === 0) throw new Error('至少留一个环境，否则部署记录没处挂')
      await api('/config', { environments: payload })
      setNote(`已保存 ${payload.length} 个环境`); toast(`已保存 ${payload.length} 个环境`)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return h('div', { className: 'ds-panel ds-form-panel' },
    h('div', { className: 'ds-panel-head' }, '部署环境', h('span', { className: 'ds-hint' }, '只登记，不触发')),
    h('div', { className: 'ds-panel-body' },
      h('div', { className: 'ds-hint' }, '这些环境只用来在版本上留痕：谁在什么时候把哪个版本放到了哪个环境。平台不会调用任何部署脚本、webhook 或 CI，部署仍然由人或你们自己的流水线完成。'),
      rows.map((row, index) => h('div', { key: `env-${index}`, className: 'ds-row', style: { gap: 8, marginTop: 8, alignItems: 'flex-end' } },
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, '名字'),
          h(TextField, {
            className: 'ds-input', value: row.name, placeholder: '例如 预发',
            onChange: event => setRow(index, { name: event.target.value }),
          }),
        ),
        h('div', { className: 'ds-field', style: { flex: '0 0 120px' } },
          h('div', { className: 'ds-label' }, '类型'),
          h(SelectField, {
            className: 'ds-input', value: row.kind,
            onChange: event => setRow(index, { kind: event.target.value }),
          }, ['dev', 'staging', 'prod', 'other'].map(kind => h('option', { key: kind, value: kind }, kind))),
        ),
        h('div', { className: 'ds-field', style: { flex: 2 } },
          h('div', { className: 'ds-label' }, '说明'),
          h(TextField, {
            className: 'ds-input', value: row.note, placeholder: '例如 上线前最后一关',
            onChange: event => setRow(index, { note: event.target.value }),
          }),
        ),
        h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => dropRow(index), 'data-danger': '1' }, '删除'),
      )),
      h('div', { className: 'ds-row', style: { gap: 8, marginTop: 10 } },
        h('button', { className: 'ds-btn', onClick: addRow, disabled: rows.length >= 12 }, '＋ 加一个环境'),
      ),
      h('div', { className: 'ds-hint' }, 'id 由名字生成一次就固定了：改名不会断开已有的部署记录；删掉的环境，历史记录里的名字会显示成 id。'),
      h('div', { className: 'ds-row', style: { justifyContent: 'flex-end', marginTop: 10 } },
        h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存环境'),
      ),
      note === null ? null : h('div', { className: 'ds-ok' }, note),
      error === null ? null : h('div', { className: 'ds-err' }, error),
    ),
    h('div', { className: 'ds-panel-body', style: { borderTop: '1px solid var(--ds-line)' } },
      h('div', { className: 'ds-label' }, '发布准入（发布时会检查，不满足要「强制发布」并写原因）'),
      h('label', { className: 'ds-check', style: { marginTop: 8 } },
        h(CheckField, { checked: (config.releaseRules?.requireStaging ?? false) === true,
          onChange: event => void saveRules({ requireStaging: event.target.checked }),
        }),
        h('span', { className: 'ds-check-text' }, '发布前必须先在「预发」环境登记过一次部署'),
      ),
      h('label', { className: 'ds-check', style: { marginTop: 6 } },
        h(CheckField, { checked: (config.releaseRules?.requireRequirementSignoff ?? false) === true,
          onChange: event => void saveRules({ requireRequirementSignoff: event.target.checked }),
        }),
        h('span', { className: 'ds-check-text' }, '关联需求必须都签过验收字'),
      ),
      h('div', { className: 'ds-hint', style: { marginTop: 6 } }, '两条默认都不勾：不勾的时候发布只看门禁，不看你上没上过预发、需不需要签字。'),
      rulesNote === null ? null : h('div', { className: 'ds-ok' }, rulesNote),
    ),
  )
}
