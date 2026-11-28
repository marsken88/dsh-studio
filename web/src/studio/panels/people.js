/* Settings panels lifted out of client.src.js; shared handles come from the studio context.
 *
 * 面板内部已经全部换成 BoardUI（Tailwind v4 token + 4px 档位），不再用手写类：
 *   - 分区 = 卡片：rounded-xl + border-separator-border + bg-background-primary-default + p-4
 *   - 小节标题 text-title-2-semibold、说明 text-caption-1-regular text-text-tertiary
 *   - 行 = 分隔线（1px + 末行去掉），动作用 BoardUI Button，状态用 Chip
 *   - 空态用 boardui/empty-state；勾选/开关用 CheckField / SwitchToggle 并**带文字标签**
 *     （以前是 <label><控件/><span> 的嵌套 label，读屏念不出名字，点文字也不生效）
 *   - 列表分区不再走共享 Editor（旧的 panel 那套），这里按同一套 token 内联
 *
 * 最外层容器是纯 Tailwind（设置页外壳已迁 BoardUI），不再借旧的 panel 类过渡。
 * 免得分区卡片外面再套一层卡片边框。
 */

import { uiIcon, expertIconName } from '../icons.js'
import { ROLE_LABEL, knownRoles } from '../labels.js'
import { client } from '../context.js'
import { Button } from '../../boardui/index'
import { EmptyState } from '../../boardui/empty-state'

/* 容器是纯 Tailwind（设置页外壳已迁 BoardUI）。
   内联样式优先级高于样式表规则，正好把旧 panel 类的描边/底色/外边距抵消掉。 */
const PANE = 'flex min-w-0 flex-col gap-3'
/* 分区：面板里的一块内容 */
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
const ROW_END = 'flex min-w-0 flex-wrap items-center justify-end gap-2'
const LISTROW = 'flex min-w-0 items-start justify-between gap-3 border-b border-separator-border py-3 last:border-b-0 last:pb-0'
const LISTROW_MAIN = 'flex min-w-0 flex-1 flex-col gap-1'
const LISTROW_TITLE = 'flex flex-wrap items-center gap-2 text-body-2-medium text-text-primary'
const LISTROW_ACTIONS = 'flex shrink-0 flex-wrap items-center gap-2'

function listSection({ h, title, hint, addLabel, onAdd, rows, empty, hook, extra }) {
  return h('div', { className: SECTION, 'data-section': hook },
    h('div', { className: SECTION_HEAD },
      h('div', { className: 'flex min-w-0 flex-col gap-1' },
        h('div', { className: SECTION_TITLE }, title),
        hint === undefined || hint === null ? null : h('div', { className: DESC }, hint),
      ),
      extra === undefined || extra === null ? null : extra,
      h(Button, { variant: 'secondary', size: 'sm', onClick: onAdd }, addLabel ?? '新增'),
    ),
    rows.length === 0
      ? h(EmptyState, { title: empty ?? '还没有内容。' })
      : h('div', { className: 'flex min-w-0 flex-col' }, rows),
  )
}

function fieldOf(h, label, control, hint) {
  return h('div', { className: FIELD },
    h('div', { className: LABEL }, label),
    control,
    hint === undefined || hint === null ? null : h('div', { className: HINT }, hint),
  )
}

/* 字段标签的悬停说明：client.src.js 的 tipLabel 内部还挂着旧的 label 类，
   面板这一层自己拼一个，免得旧类名从共享函数里漏出来。 */
function labelTip(h, tipOf, text, hint) {
  const node = h('div', { className: LABEL, style: { cursor: 'help' } }, text)
  return hint === undefined || hint === null || hint === '' ? node : tipOf(hint, node)
}

export function ExpertsPanel({ config, onChanged }) {
  const { h, React, api, toast, promptDialog, confirmDialog, tipOf, TextField, TextAreaField, ChipField, CheckField, SwitchToggle, SelectField, SideDrawer } = client()
  const experts = config.experts ?? []
  const roles = knownRoles(config)
  const [draft, setDraft] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  /* 和某位专家「发起一次会话」（issue #148）：说一句想聊什么就开聊——
     不建卡、不派单、不往看板写评论，聊清楚再决定建不建需求/卡。 */
  const startChat = async (expert) => {
    const topic = await promptDialog(`和「${expert.name}」聊什么？`, {
      title: '发起会话',
      placeholder: '例如：下个版本结算模块先做哪几张卡？',
      okText: '开聊',
    })
    if (topic === null || String(topic).trim() === '') return
    setBusy(true); setError(null)
    try {
      const out = await api('/agents/chat', { expert: expert.id, topic: String(topic).trim() })
      toast(out.hint ?? `已和「${expert.name}」发起会话`, 'success')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

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
  /* 角色位（岗位白名单，issue #150）：没有这个入口的话，「加财务/支持等岗位」就只能手打
     POST /config —— 能力在接口里、界面里选不到，等于没做。删岗位前平台会检查
     「还有专家或列负责人在用」，挡下来就把原因显示出来。 */
  const [roleInput, setRoleInput] = React.useState('')
  const saveRoles = async next => {
    setBusy(true); setError(null)
    try { await api('/config', { roles: next }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const addRole = () => {
    const id = roleInput.trim().toLowerCase()
    if (id === '') return
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) { setError('角色 id 只能是小写字母 / 数字 / 连字符，且以字母开头（如 finance、support-lead）'); return }
    if (roles.includes(id)) { setError(`角色「${id}」已经在白名单里`); return }
    setRoleInput('')
    void saveRoles([...roles, id])
  }
  const removeRole = role => {
    if (roles.length <= 1) { setError('至少保留一个角色位（全删了就没人能被列负责人选中）'); return }
    void saveRoles(roles.filter(item => item !== role))
  }
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
  const rows = experts.map(expert => h('div', { className: LISTROW, key: expert.id, 'data-expert-row': '' },
    h('div', { className: LISTROW_MAIN },
      h('div', { className: LISTROW_TITLE },
        uiIcon(h, expertIconName(expert)),
        h('span', { className: 'min-w-0 truncate' }, expert.name),
        expert.domain ? h(ChipField, { variant: 'gray' }, expert.domain) : null,
        expert.enabled === false ? h('span', { className: HINT }, '已停用') : null,
      ),
      h('div', { className: HINT }, `${expert.model || '跟随默认模型'}${expert.description ? ' · ' + expert.description : ''}`),
      promptPreview(expert.prompt) === ''
        ? h('div', { className: HINT, 'data-empty': '1' }, '提示词：还没有写，会退回该角色位的一句话职责（点「编辑」补上完整要求）')
        : h('div', {
            className: HINT,
            'data-prompt': '1',
            title: String(expert.prompt ?? ''),
            style: { cursor: 'pointer' },
            onClick: () => setDraft({ ...expert }),
          }, `提示词：${promptPreview(expert.prompt)}`),
      (expert.skills ?? []).length > 0 ? h('div', { className: HINT }, `技能：${expert.skills.join('、')}`) : null,
    ),
    h('div', { className: LISTROW_ACTIONS },
      tipOf('和这位专家发起一次会话（不建卡、不派单）', h(Button, {
        variant: 'ghost', size: 'sm', disabled: busy, 'data-chat': 'expert',
        onClick: () => void startChat(expert),
      }, '发起会话')),
      tipOf('编辑这位专家', h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft({ ...expert }) }, '编辑')),
      tipOf('删除这位专家', h(Button, { variant: 'danger', size: 'sm', disabled: busy, onClick: () => void remove(expert), 'data-danger': '1' }, '删除')),
    ),
  ))

  return h('div', { className: PANE, 'data-panel': 'people-experts' },
    listSection({
      h, hook: 'experts',
      title: '专家（可在评论里 @ 他们）',
      hint: '每个专家有名字、业务领域、角色提示词和技能；评论里 @名字 就会把这条工作派给他。',
      rows, addLabel: '新增专家',
      onAdd: () => setDraft({ id: '', name: '', emoji: '🧩', role: '', domain: '', description: '', prompt: '', skills: [], model: '', preset: '', sandbox: '', enabled: true }),
      empty: '还没有专家，点「新增专家」建一个。',
    }),
    h('div', { className: 'flex min-w-0 flex-col gap-3 rounded-xl border border-separator-border bg-background-primary-default p-4', 'data-section': 'roles' },
      h('div', { className: SECTION_TITLE }, '角色位（岗位白名单）'),
      h('div', { className: HINT }, '角色位是「按业务领域挑人」的依据（专家岗位 / 列负责人 / 卡片 role 都按它校验）。有财务、支持等岗位就在这里加；删岗位前先把用到它的专家和列改掉。'),
      h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2', 'data-role-chips': roles.join(',') },
        roles.map(role => h(ChipField, { key: role, variant: 'gray', 'data-role-chip': role },
          ROLE_LABEL[role] ?? role,
          h(Button, {
            variant: 'ghost', size: 'xs', disabled: busy || roles.length <= 1,
            'aria-label': `从岗位白名单里删掉 ${ROLE_LABEL[role] ?? role}`,
            title: '从白名单里删掉',
            onClick: () => removeRole(role),
          }, '×'),
        )),
      ),
      h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2' },
        h(TextField, {
          style: { maxWidth: 220 }, value: roleInput, placeholder: '新岗位 id，如 finance',
          'aria-label': '新岗位 id',
          onChange: e => setRoleInput(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); addRole() } },
        }),
        h(Button, { variant: 'secondary', size: 'sm', disabled: busy || roleInput.trim() === '', onClick: () => addRole() }, '加上岗位'),
      ),
    ),
    h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-separator-border bg-background-primary-default p-4', 'data-section': 'batch-domain' },
      h('span', { className: DESC }, '按业务领域一次生成四位：'),
      h(TextField, {
        style: { maxWidth: 180 }, value: batchDomain, placeholder: '支付 / 风控 / 会员',
        onChange: e => setBatchDomain(e.target.value),
      }),
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy || batchDomain.trim().length === 0, onClick: () => void createDomainSet() }, '生成产品/架构/研发/测试'),
      error !== null && draft === null ? h('span', { className: ERR, role: 'alert' }, error) : null,
    ),
    draft === null ? null : h(SideDrawer, {
      title: draft.id ? `编辑专家：${draft.name || draft.id}` : '新增专家',
      hint: '技能与提示词会随下一次派活生效，改完点右下角「保存」。',
      onClose: () => setDraft(null),
      footer: [
        h(Button, { key: 'save', variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
        h(Button, { key: 'cancel', variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: ERR }, error) : null,
      ],
    },
        fieldOf(h, '名字（@ 用这个名字）',
          h(TextField, { value: draft.name, placeholder: '安全专家', onChange: e => set('name', e.target.value) })),
        h('div', { className: HINT }, '图标由角色决定（产品 / 架构 / 研发 / 测试各一个），全站一致，不用再挑 emoji。'),
        fieldOf(h, '一句话定位',
          h(TextField, { value: draft.description, placeholder: '负责接口安全与权限模型评审', onChange: e => set('description', e.target.value) })),
        h('div', { className: 'flex min-w-0 items-start gap-3' },
          h('div', { className: FIELD, style: { flex: '0 0 132px' } },
            labelTip(h, tipOf, '角色位', '决定它对应看板上的哪一列；列负责人按角色位挑人时用得上'),
            h(SelectField, {
              size: 'md',
              value: draft.role ?? '',
              'aria-label': '角色位',
              onChange: e => set('role', e.target.value),
            },
              h('option', { value: '' }, '不限'),
              roles.map(v => h('option', { key: v, value: v }, ROLE_LABEL[v] ?? v))),
            h('div', { className: HINT }, roles.length === 5 ? '决定默认接哪一列' : `决定默认接哪一列（可选 ${roles.length} 个角色位）`),
          ),
          h('div', { className: FIELD, style: { flex: 1 } },
            labelTip(h, tipOf, '业务领域', '「按专长匹配」看这里：领域相同的卡优先派给它'),
            h(TextField, { value: draft.domain ?? '', placeholder: '支付 / 风控 / 会员（选填）', onChange: e => set('domain', e.target.value) }),
            h('div', { className: HINT }, '同一张卡会优先派给同领域的专家'),
          ),
        ),
        h('div', { className: FIELD },
          h('div', { className: LABEL }, `技能（从技能库勾选 · 已选 ${(draft.skills ?? []).length} 项）`),
          library.length > 0
            ? h('div', { className: 'flex max-h-[190px] min-w-0 flex-col gap-1 overflow-y-auto rounded-xl border border-separator-border bg-background-secondary-default p-2' },
              library.map(skill => {
                const on = (draft.skills ?? []).includes(skill.name)
                const users = experts.filter(item => (item.skills ?? []).includes(skill.name)).length
                return h('div', {
                  key: skill.name,
                  className: 'flex min-w-0 items-center gap-2 rounded-lg px-1 py-1',
                  'data-on': on ? '1' : '0',
                  title: String(skill.description ?? ''),
                },
                  h(CheckField, { checked: on, 'aria-label': skill.name, onChange: () => toggleSkill(skill.name) }),
                  h('span', { className: 'font-mono text-caption-1-regular text-text-primary' }, skill.name),
                  h('span', { className: 'min-w-0 flex-1 truncate text-caption-1-regular text-text-tertiary' }, String(skill.description ?? '').slice(0, 46)),
                  users > 0 ? h('span', { className: 'shrink-0 text-caption-1-regular text-text-tertiary' }, `${users} 位在用`) : null,
                )
              }),
            )
            : h('div', { className: HINT }, '技能库还是空的，去「技能库」建一条，或者在下面直接写名字。'),
          h('div', { className: ROW },
            h(TextField, {
              style: { flex: 1 }, value: skillInput,
              placeholder: '技能库以外的技能名，例如 lark-doc、office-xlsx（回车或点「加上」）',
              onChange: e => setSkillInput(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); addSkillName() } },
            }),
            h(Button, { variant: 'secondary', size: 'sm', onClick: () => addSkillName() }, '加上'),
          ),
          (draft.skills ?? []).filter(name => !library.some(skill => skill.name === name)).length > 0
            ? h('div', { className: ROW },
              h('span', { className: HINT }, '不在技能库（仍会写进提示词）：'),
              (draft.skills ?? []).filter(name => !library.some(skill => skill.name === name)).map(name => h(ChipField, { key: name, variant: 'rose', 'data-missing': '1' },
                name,
                h(Button, { variant: 'ghost', size: 'xs', 'aria-label': `移除技能 ${name}`, onClick: () => set('skills', (draft.skills ?? []).filter(entry => entry !== name)) }, '×'),
              )),
            )
            : null,
        ),
        h('div', { className: 'flex min-w-0 flex-wrap items-start gap-2' },
          h('div', { className: FIELD, style: { flex: 1 } },
            h('div', { className: LABEL }, '模型'),
            h(TextField, { value: draft.model, placeholder: 'deepseek-v4.1-flash（留空跟随角色默认）', onChange: e => set('model', e.target.value) }),
          ),
          h('div', { className: FIELD, style: { flex: 1 } },
            labelTip(h, tipOf, 'Agent 预设', '预设决定这个专家能用哪些工具、以什么身份干活（如 standard、架构师）'),
            h(TextField, { value: draft.preset, placeholder: 'standard', onChange: e => set('preset', e.target.value) }),
          ),
          h('div', { className: FIELD, style: { flex: 1 } },
            labelTip(h, tipOf, '沙箱档位', 'read-only 只能看；workspace-write 能改工作区；danger-full-access 不做限制'),
            h(SelectField, {
              size: 'md',
              value: draft.sandbox ?? '',
              'aria-label': '沙箱档位',
              onChange: e => set('sandbox', e.target.value),
            },
              [['', '跟随全局'],
                ['read-only', '只读'],
                ['workspace-write', '只写工作区'],
                ['danger-full-access', '无沙箱']].map(([id, label]) =>
                h('option', { key: id, value: id }, label)),
            ),
            h('div', { className: HINT }, '研发/测试这类要真跑命令的专家建议「只写工作区」。'),
          ),
        ),
        fieldOf(h, '角色提示词（每次派活都会作为系统提示发给这个专家）',
          h(TextAreaField, {
            rows: 9, value: draft.prompt,
            placeholder: '例如：\n你是支付域的产品经理。先读 docs/ 与支付相关的 ADR，再动手。\n需求必须写清：目标用户、主流程、异常与退款路径、对账口径。\n不确定的地方去代码或历史工单里找证据，禁止编造接口字段。',
            onChange: e => set('prompt', e.target.value),
          })),
        h(SwitchToggle, {
          checked: draft.enabled !== false,
          label: '启用这个专家',
          onChange: e => set('enabled', e.target.checked),
        }),
    ),
  )
}

export function TeamsPanel({ config, onChanged }) {
  const { h, React, api, toast, promptDialog, confirmDialog, tipOf, TextField, CheckField, SelectField, SideDrawer } = client()
  const teams = config.teams ?? []
  const experts = config.experts ?? []
  const [draft, setDraft] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  /* 和整个专家团「发起一次会话」：由团长接话，需要成员接手时会 @ 他。同样不建卡（issue #148）。 */
  const startChat = async (team) => {
    const topic = await promptDialog(`和「${team.name}」聊什么？（团长 ${(experts.find(item => item.id === team.lead)?.name ?? team.lead) || '—'} 接话）`, {
      title: '发起会话',
      placeholder: '例如：下个版本这个团先接哪几张卡？',
      okText: '开聊',
    })
    if (topic === null || String(topic).trim() === '') return
    setBusy(true); setError(null)
    try {
      const out = await api('/agents/chat', { expert: team.id, topic: String(topic).trim() })
      toast(out.hint ?? `已和「${team.name}」发起会话`, 'success')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  // 团级记忆：卡做完/缺陷修完会自动记一条，派活时会带进专家提示词。
  const [memory, setMemory] = React.useState({})
  React.useEffect(() => {
    let alive = true
    void api('/team/memory', {}).then(out => { if (alive) setMemory(out?.memory ?? {}) }).catch(() => {})
    return () => { alive = false }
  }, [config.teams])
  const clearMemory = async team => {
    if (!(await confirmDialog('清空「' + team.name + '」的团队记忆？', { title: '清空团队记忆', danger: true, okText: '清空' }))) return
    try {
      const out = await api('/team/memory/clear', { teamId: team.id })
      setMemory(out?.memory ?? {})
      toast('已清空这个团的记忆')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const nameOf = id => {
    const found = experts.find(expert => expert.id === id)
    return found === undefined ? id : found.name
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

  const rows = teams.map(team => h('div', { className: LISTROW, key: team.id, 'data-team-row': '' },
    h('div', { className: LISTROW_MAIN },
      h('div', { className: LISTROW_TITLE }, team.name),
      h('div', { className: HINT }, `团长 ${nameOf(team.lead)} · 成员 ${team.members.map(nameOf).join('、')}`),
      h('div', { className: HINT }, (memory[team.id] ?? []).length === 0
        ? '团队记忆：还没有（卡做完会自动记一条，派活时带进提示词）'
        : `团队记忆 ${memory[team.id].length} 条 · 最近：${memory[team.id][0]?.outcome ?? ''} ${memory[team.id][0]?.title ?? ''}`),
    ),
    h('div', { className: LISTROW_ACTIONS },
      tipOf('和这个专家团发起一次会话（团长接话，不建卡）', h(Button, {
        variant: 'ghost', size: 'sm', disabled: busy, 'data-chat': 'team',
        onClick: () => void startChat(team),
      }, '发起会话')),
      tipOf('清空这个团的记忆', h(Button, { variant: 'ghost', size: 'sm', disabled: busy || (memory[team.id] ?? []).length === 0, onClick: () => void clearMemory(team) }, '清空记忆')),
      tipOf('编辑这个专家团', h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft({ ...team }) }, '编辑')),
      tipOf('删除这个专家团', h(Button, { variant: 'danger', size: 'sm', disabled: busy, onClick: () => void remove(team), 'data-danger': '1' }, '删除')),
    ),
  ))

  return h('div', { className: PANE, 'data-panel': 'people-teams' },
    listSection({
      h, hook: 'teams',
      title: '专家团（一起干活）',
      hint: '专家团有团长和成员。评论里 @团名，团长会拆活、给成员派活并汇总结论；成员之间可以继续 @ 接棒。',
      rows, addLabel: '新增专家团',
      onAdd: () => setDraft({ id: '', name: '', description: '', members: [], lead: '', enabled: true }),
      empty: '还没有专家团。',
    }),
    error !== null && draft === null ? h('div', { className: ERR, role: 'alert' }, error) : null,
    draft === null ? null : h(SideDrawer, {
      title: draft.id ? `编辑专家团：${draft.name || draft.id}` : '新增专家团',
      hint: '团长负责拆活，成员之间在评论里用 @名字 接棒；改完点右下角「保存」。',
      onClose: () => setDraft(null),
      footer: [
        h(Button, { key: 'save', variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
        h(Button, { key: 'cancel', variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        error !== null ? h('span', { key: 'error', className: ERR }, error) : null,
      ],
    },
        fieldOf(h, '团名（@ 用这个名字）',
          h(TextField, { value: draft.name, placeholder: '需求交付组', onChange: e => set('name', e.target.value) })),
        fieldOf(h, '这个团负责什么',
          h(TextField, { value: draft.description, placeholder: '从需求澄清一路做到验收', onChange: e => set('description', e.target.value) })),
        h('div', { className: FIELD },
          h('div', { className: LABEL }, '成员'),
          experts.length === 0
            ? h('div', { className: HINT }, '先去上面建几个专家。')
            : h('div', { className: 'flex min-w-0 flex-col gap-2' },
              experts.map(expert => h(CheckField, {
                key: expert.id,
                checked: (draft.members ?? []).includes(expert.id),
                onChange: e => set('members', e.target.checked
                  ? [...(draft.members ?? []), expert.id]
                  : (draft.members ?? []).filter(id => id !== expert.id)),
              }, expert.name)),
            ),
        ),
        fieldOf(h, '团长（负责拆活和汇总）',
          h(SelectField, {
            size: 'md',
            value: draft.lead ?? '',
            'aria-label': '团长',
            onChange: e => set('lead', e.target.value),
          },
            h('option', { value: '' }, '自动（第一个成员）'),
            (draft.members ?? []).map(id => h('option', { key: id, value: id }, nameOf(id))),
          )),
    ),
  )
}

export function TestingPanel({ config, onChanged }) {
  const { h, React, api, toast, confirmDialog, tipOf, TextField, CheckField, SwitchToggle, SideDrawer } = client()
  const testing = config.testing ?? {}
  const envs = Array.isArray(testing.envs) ? testing.envs : []
  const [draft, setDraft] = React.useState(null)
  const [hosts, setHosts] = React.useState((Array.isArray(testing.allowHosts) ? testing.allowHosts : []).join(', '))
  const [timeoutText, setTimeoutText] = React.useState(String(testing.timeoutMs ?? 15000))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [note, setNote] = React.useState(null)
  const [flags, setFlags] = React.useState({ allowShell: testing.allowShell === true, allowDb: testing.allowDb === true, allowBrowser: testing.allowBrowser === true })
  const [browserPath, setBrowserPath] = React.useState(String(testing.browserPath ?? ''))
  const [shellCwdDraft, setShellCwdDraft] = React.useState(String(testing.shellCwd ?? ''))
  /* 整批跑用例的并发：以前只能打 /config 改，界面上没有输入框。 */
  const [concurrencyDraft, setConcurrencyDraft] = React.useState(String(testing.concurrency ?? 4))
  const [limitsDraft, setLimitsDraft] = React.useState({
    casesPerTask: config.limits?.casesPerTask ?? 60,
    runKeys: config.limits?.runKeys ?? 60,
    artifactsPerTask: config.limits?.artifactsPerTask ?? 40,
  })
  const [hooks, setHooks] = React.useState(() => (Array.isArray(config.webhooks) ? config.webhooks : []).map(hook => ({ ...hook })))
  const saveFlags = async next => {
    setFlags(next)
    setBusy(true); setNote(null)
    try { await api('/config', { testing: { ...testing, allowShell: next.allowShell, allowDb: next.allowDb, allowBrowser: next.allowBrowser } }); setNote('已保存'); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const saveLimits = async () => {
    setBusy(true); setNote(null)
    try { await api('/config', { limits: limitsDraft }); setNote('上限已保存'); toast('上限已保存'); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const saveHooks = async () => {
    setBusy(true); setNote(null)
    try { await api('/config', { webhooks: hooks.filter(hook => String(hook.url ?? '').trim() !== '') }); setNote('webhook 已保存'); toast('webhook 已保存'); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

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

  const envRow = env => h('div', { key: env.id, className: LISTROW, 'data-env-row': '' },
    h('div', { className: LISTROW_MAIN },
      h('div', { className: LISTROW_TITLE },
        h('span', { className: 'min-w-0 truncate' }, env.name),
        testing.defaultEnv === env.id ? h('span', { className: HINT }, '默认') : null,
      ),
      h('div', { className: HINT }, env.baseUrl === '' ? '相对地址会因为没有 baseUrl 而失败' : env.baseUrl),
    ),
    h('div', { className: LISTROW_ACTIONS },
      testing.defaultEnv === env.id ? null : h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void push({ defaultEnv: env.id }) }, '设为默认'),
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft({ ...env }) }, '编辑'),
      h(Button, { variant: 'danger', size: 'sm', disabled: busy, onClick: () => void removeEnv(env), 'data-danger': '1' }, '删除'),
    ),
  )

  const form = draft === null ? null : h('div', { className: SECTION, 'data-section': 'env-form' },
    h('div', { className: SECTION_TITLE }, draft.id === undefined || draft.id === '' ? '新增环境' : `编辑环境：${draft.name}`),
    fieldOf(h, '环境名',
      h(TextField, { value: draft.name ?? '', placeholder: '例如 测试环境 / 预发环境', onChange: event => setDraft({ ...draft, name: event.target.value }) })),
    fieldOf(h, labelTip(h, tipOf, 'baseUrl', '接口测试的根地址，用例里的 /path 会拼在它后面'),
      h(TextField, { value: draft.baseUrl ?? '', placeholder: 'https://test.example.com', onChange: event => setDraft({ ...draft, baseUrl: event.target.value }) })),
    h('div', { className: ROW_END },
      h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft(null) }, '取消'),
      h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveEnv() }, '保存环境'),
    ),
  )

  return h('div', { className: PANE, 'data-panel': 'people-testing' },
    form,
    h('div', { className: SECTION, 'data-section': 'run-flags' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '执行开关'),
          h('div', { className: DESC }, '默认都关：打开等于把宿主机的能力交给看板使用者'),
        ),
      ),
      h(CheckField, {
        checked: flags.allowShell,
        disabled: busy,
        onChange: e => void saveFlags({ ...flags, allowShell: e.target.checked }),
      }, '允许 shell 用例（能在宿主机执行命令）'),
      h(CheckField, {
        checked: flags.allowDb,
        disabled: busy,
        onChange: e => void saveFlags({ ...flags, allowDb: e.target.checked }),
      }, '允许数据库用例（默认只读打开 SQLite）'),
      h(CheckField, {
        checked: flags.allowBrowser,
        disabled: busy,
        onChange: e => void saveFlags({ ...flags, allowBrowser: e.target.checked }),
      }, '允许浏览器用例（真开 Chrome / Edge 打开页面；能访问内网地址，风险同 shell）'),
      fieldOf(h, '浏览器可执行文件（留空则自动找 Chrome / Edge，或读环境变量 CHROME_PATH）',
        h(TextField, {
          value: browserPath, placeholder: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          onChange: e => setBrowserPath(e.target.value),
          onBlur: async () => {
            setBusy(true); setNote(null)
            try { await api('/config', { testing: { ...testing, allowBrowser: flags.allowBrowser, browserPath } }); setNote('已保存'); await onChanged() }
            catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
          },
        })),
      /* shell 用例的默认工作目录：用例里给了 cwd 就用它的，没给就用这里。
         以前只能在 /config 里改，界面上完全看不到（表现是「命令跑了但找不到文件」）。 */
      fieldOf(h, 'shell 用例的默认工作目录（留空 = 进程当前目录）',
        h(TextField, {
          value: shellCwdDraft, placeholder: '例如 /srv/app 或 E:/work/repo',
          'aria-label': 'shell 用例的默认工作目录',
          onChange: e => setShellCwdDraft(e.target.value),
          onBlur: async () => {
            setBusy(true); setNote(null)
            try { await api('/config', { testing: { ...testing, allowShell: flags.allowShell, shellCwd: shellCwdDraft } }); setNote('已保存'); await onChanged() }
            catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
          },
        })),
      /* 整批跑用例的并发（1–8）：以前只在保存载荷里带着，界面上没有输入框。 */
      fieldOf(h, '整批跑用例的并发（1–8，默认 4）',
        h(TextField, {
          type: 'number',
          'aria-label': '整批跑用例的并发',
          value: String(concurrencyDraft),
          onChange: e => setConcurrencyDraft(e.target.value),
          onBlur: async () => {
            const value = Math.min(8, Math.max(1, Math.trunc(Number(concurrencyDraft)) || 4))
            setConcurrencyDraft(String(value))
            setBusy(true); setNote(null)
            try { await api('/config', { testing: { ...testing, allowShell: flags.allowShell, concurrency: value } }); setNote('已保存：并发 ' + value); await onChanged() }
            catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
          },
        })),
    ),
    h('div', { className: SECTION, 'data-section': 'limits' },
      h('div', { className: SECTION_TITLE }, '数量上限'),
      h('div', { className: 'flex min-w-0 flex-wrap items-start gap-2' },
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '每张卡用例上限'),
          h(TextField, { type: 'number', 'aria-label': '每张卡最多几条用例', value: String(limitsDraft.casesPerTask), onChange: e => setLimitsDraft({ ...limitsDraft, casesPerTask: Number(e.target.value) }) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '一次批量跑上限'),
          h(TextField, { type: 'number', 'aria-label': '一次最多跑几条用例', value: String(limitsDraft.runKeys), onChange: e => setLimitsDraft({ ...limitsDraft, runKeys: Number(e.target.value) }) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '交付物上限'),
          h(TextField, { type: 'number', 'aria-label': '每张卡最多几件交付物', value: String(limitsDraft.artifactsPerTask), onChange: e => setLimitsDraft({ ...limitsDraft, artifactsPerTask: Number(e.target.value) }) }),
        ),
      ),
      h('div', { className: ROW_END },
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveLimits() }, '保存上限'),
      ),
    ),
    h('div', { className: SECTION, 'data-section': 'webhooks' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' }, h('div', { className: SECTION_TITLE }, '出站 webhook')),
        h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setHooks(list => [...list, { url: '', events: ['task/moved'], enabled: true }]) }, '加一个'),
      ),
      hooks.length === 0
        ? h(EmptyState, { title: '还没有 webhook。配一个就能把卡片流转、用例失败、门禁拦截推给 CI / IM / 工单系统。' })
        : h('div', { className: 'flex min-w-0 flex-col gap-3' },
          hooks.map((hook, index) => h('div', { key: index, className: 'flex min-w-0 flex-col gap-2 rounded-lg border border-separator-border p-3' },
            h('div', { className: ROW },
              h(TextField, { style: { flex: 1 }, placeholder: 'https://ci.example/hook', 'aria-label': `第 ${index + 1} 个 webhook 地址`, value: hook.url ?? '', onChange: e => setHooks(list => list.map((item, i) => (i === index ? { ...item, url: e.target.value } : item))) }),
              h(SwitchToggle, { checked: hook.enabled !== false, label: '启用', onChange: e => setHooks(list => list.map((item, i) => (i === index ? { ...item, enabled: e.target.checked } : item))) }),
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy, 'aria-label': `删除第 ${index + 1} 个 webhook`, onClick: () => setHooks(list => list.filter((_, i) => i !== index)) }, '删除'),
            ),
            h('div', { className: 'flex min-w-0 flex-wrap items-center gap-3' },
              ['task/moved', 'case/failed', 'gate/blocked', 'agent/failed', 'regression/finished'].map(name => h(CheckField, {
                key: name,
                checked: (hook.events ?? []).includes(name),
                onChange: e => setHooks(list => list.map((item, i) => (i === index
                  ? { ...item, events: e.target.checked ? Array.from(new Set([...(item.events ?? []), name])) : (item.events ?? []).filter(x => x !== name) }
                  : item))),
              }, name)),
              (hook.events ?? []).length === 0
                ? h('span', { className: HINT }, '一个都没勾 = 订阅全部事件')
                : null,
            ),
          )),
        ),
      hooks.length === 0 ? null : h('div', { className: ROW_END },
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveHooks() }, '保存 webhook'),
      ),
    ),
    h('div', { className: SECTION, 'data-section': 'test-envs' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' }, h('div', { className: SECTION_TITLE }, '测试环境')),
        h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft({ name: '', baseUrl: '' }) }, '新增环境'),
      ),
      envs.length === 0
        ? h(EmptyState, { title: '还没有环境。接口用例里的相对地址会拼到这里配置的 baseUrl。' })
        : h('div', { className: 'flex min-w-0 flex-col' }, envs.map(envRow)),
    ),
    h('div', { className: SECTION, 'data-section': 'constraints' },
      h('div', { className: SECTION_TITLE }, '执行约束'),
      fieldOf(h, '允许访问的域名（逗号分隔，支持 *.example.com）',
        h(TextField, { value: hosts, placeholder: '127.0.0.1, localhost, test.example.com', onChange: event => setHosts(event.target.value) })),
      fieldOf(h, '单条用例超时（毫秒）',
        h(TextField, { value: timeoutText, onChange: event => setTimeoutText(event.target.value) })),
      h('div', { className: ROW_END },
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveHosts() }, busy ? '保存中…' : '保存约束'),
      ),
      note === null ? null : h('div', { className: OK, role: 'status' }, note),
      error === null ? null : h('div', { className: ERR, role: 'alert' }, error),
    ),
  )
}

/** 通知升级：通道连续失败达到阈值时，往另一个群发一条，别和日常通知混在一起。 */
export function EscalatePanel({ config, onChanged }) {
  const { h, React, api, TextField } = client()
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
  return h('div', { className: PANE, style: { marginTop: 16 }, 'data-panel': 'people-escalate' },
    h('div', { className: SECTION, 'data-section': 'escalate' },
      h('div', { className: SECTION_TITLE }, '通知升级'),
      fieldOf(h, '升级群 Webhook',
        h(TextField, {
          value: hook,
          placeholder: feishu.escalateWebhookSet === true ? '已设置（留空表示不修改）' : 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
          onChange: event => setHook(event.target.value),
        })),
      fieldOf(h, '连续失败几次后升级',
        h(TextField, { style: { width: 90 }, value: after, onChange: event => setAfter(event.target.value) }),
        '同一通道连续失败到这个次数，就给升级群发消息'),
      h('div', { className: HINT }, '飞书通知、GitLab、云盘归档、代码隔离任一通道连续失败达到阈值时，只在跨过阈值那一次往升级群发一条，包含通道、失败次数与最近错误。'),
      h('div', { className: ROW_END },
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存升级设置'),
      ),
      note === null ? null : h('div', { className: OK, role: 'status' }, note),
      error === null ? null : h('div', { className: ERR, role: 'alert' }, error),
    ),
  )
}

/** 部署环境：只用于登记「版本上过哪个环境」，平台不触发任何部署。 */
export function EnvironmentsPanel({ config, onChanged }) {
  const { h, React, api, toast, TextField, SelectField, CheckField } = client()
  const [rows, setRows] = React.useState(() => (config.environments ?? []).map(env => ({ id: env.id, name: env.name, kind: env.kind, note: env.note })))
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [rulesNote, setRulesNote] = React.useState(null)
  /* 发布准入：成功/失败要分开显示 —— 以前失败也写进绿色那行，看起来像保存成功了。 */
  const saveRules = async patch => {
    setRulesNote(null)
    try {
      await api('/config', { releaseRules: patch })
      setRulesNote({ ok: true, text: '发布准入已更新' })
      await onChanged()
    } catch (cause) {
      setRulesNote({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
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
  return h('div', { className: PANE, 'data-panel': 'people-environments' },
    h('div', { className: SECTION, 'data-section': 'environments' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '部署环境'),
          h('div', { className: DESC }, '只登记，不触发'),
        ),
      ),
      h('div', { className: HINT }, '这些环境只用来在版本上留痕：谁在什么时候把哪个版本放到了哪个环境。平台不会调用任何部署脚本、webhook 或 CI，部署仍然由人或你们自己的流水线完成。'),
      rows.length === 0
        ? h(EmptyState, { title: '还没有环境。至少留一个，否则部署记录没处挂。' })
        : h('div', { className: 'flex min-w-0 flex-col gap-3' }, rows.map((row, index) => h('div', { key: `env-${index}`, className: 'flex min-w-0 flex-wrap items-end gap-2', 'data-deploy-env-row': '' },
          h('div', { className: FIELD, style: { flex: 1 } },
            h('div', { className: LABEL }, '名字'),
            h(TextField, {
              value: row.name, placeholder: '例如 预发', 'aria-label': `第 ${index + 1} 个环境的名字`,
              onChange: event => setRow(index, { name: event.target.value }),
            }),
          ),
          h('div', { className: FIELD, style: { flex: '0 0 120px' } },
            h('div', { className: LABEL }, '类型'),
            h(SelectField, {
              size: 'md',
              value: row.kind,
              'aria-label': `第 ${index + 1} 个环境的类型`,
              onChange: event => setRow(index, { kind: event.target.value }),
            }, ['dev', 'staging', 'prod', 'other'].map(kind => h('option', { key: kind, value: kind }, kind))),
          ),
          h('div', { className: FIELD, style: { flex: 2 } },
            h('div', { className: LABEL }, '说明'),
            h(TextField, {
              value: row.note, placeholder: '例如 上线前最后一关', 'aria-label': `第 ${index + 1} 个环境的说明`,
              onChange: event => setRow(index, { note: event.target.value }),
            }),
          ),
          h(Button, { variant: 'danger', size: 'sm', 'aria-label': `删除第 ${index + 1} 个环境`, onClick: () => dropRow(index), 'data-danger': '1' }, '删除'),
        ))),
      h('div', { className: ROW },
        h(Button, { variant: 'secondary', size: 'sm', onClick: addRow, disabled: rows.length >= 12 }, '加一个环境'),
      ),
      h('div', { className: HINT }, 'id 由名字生成一次就固定了：改名不会断开已有的部署记录；删掉的环境，历史记录里的名字会显示成 id。'),
      h('div', { className: ROW_END },
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存环境'),
      ),
      note === null ? null : h('div', { className: OK, role: 'status' }, note),
      error === null ? null : h('div', { className: ERR, role: 'alert' }, error),
      h('div', { className: 'flex min-w-0 flex-col gap-2 border-t border-separator-border pt-3' },
        h('div', { className: LABEL }, '发布准入（发布时会检查，不满足要「强制发布」并写原因）'),
        h(CheckField, {
          checked: (config.releaseRules?.requireStaging ?? false) === true,
          onChange: event => void saveRules({ requireStaging: event.target.checked }),
        }, '发布前必须先在「预发」环境登记过一次部署'),
        h(CheckField, {
          checked: (config.releaseRules?.requireRequirementSignoff ?? false) === true,
          onChange: event => void saveRules({ requireRequirementSignoff: event.target.checked }),
        }, '关联需求必须都签过验收字'),
        h('div', { className: HINT }, '两条默认都不勾：不勾的时候发布只看门禁，不看你上没上过预发、需不需要签字。'),
        rulesNote === null ? null : h('div', { className: rulesNote.ok === true ? OK : ERR, role: rulesNote.ok === true ? 'status' : 'alert', 'data-release-rules-note': rulesNote.ok === true ? 'ok' : 'error' }, rulesNote.text),
      ),
    ),
  )
}
