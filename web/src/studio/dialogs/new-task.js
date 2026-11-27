/* 新建任务 / 登记缺陷对话框。
 *
 * 从 client.src.js 的 NewTaskDialog 原样迁出来，只换表现层：
 *   · 壳 = 固定覆盖层 + 卡片（Tailwind token + 4px 档位），不再是旧的 modal 类；
 *   · 字段仍走共享的 TextField / SelectField / DateField / MdField（BoardUI 适配层，语义不变）；
 *   · 动作走 BoardUI Button；点遮罩关闭、Enter 提交、默认挂当前迭代这些行为一个没动。
 *
 * 覆盖层保留桌面版的标题栏下沉（env(titlebar-area-height) 与 --ds-titlebar-floor 兜底），
 * 与抽屉/命令面板同一套规则（issue #4）。
 */
import { Button } from '../../boardui/index'
import { PRIORITY_LABEL, SEVERITY_LABEL, TYPE_LABEL } from '../labels.js'
import { fromDateInput } from '../roster.js'
import { client } from '../context.js'

const OVERLAY = 'fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-6'
/* 桌面客户端把覆盖层下沉，别钻到系统标题栏下面（普通浏览器里 env() 为 0，行为不变）。 */
const OVERLAY_STYLE = {
  top: 'max(env(titlebar-area-height, 0px), var(--ds-titlebar-floor, 0px))',
  WebkitAppRegion: 'no-drag',
}
const CARD = 'flex max-h-[min(86vh,760px)] w-[min(560px,96vw)] flex-col gap-4 overflow-auto rounded-2xl border border-separator-border bg-background-primary-default p-5 shadow-xl'
const HEAD = 'text-title-3-semibold text-text-primary'
const FIELD = 'flex min-w-0 flex-col gap-1'
const LABEL = 'text-caption-2-medium text-text-secondary'
const HINT = 'text-caption-1-regular text-text-tertiary'
const GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2'
const FULL = 'sm:col-span-2'
const FOOT = 'flex items-center gap-3 pt-1'

export function NewTaskDialog({ state, onClose, onCreated }) {
  const { h, React, api, TextField, SelectField, DateField, MdField } = client()
  const projects = state?.config?.projects ?? []
  const [title, setTitle] = React.useState('')
  const [requirement, setRequirement] = React.useState('')
  const [type, setType] = React.useState('requirement')
  const [priority, setPriority] = React.useState('normal')
  const [severity, setSeverity] = React.useState('p2')
  const [domain, setDomain] = React.useState('')
  const requirements = state?.requirements ?? []
  const [requirementId, setRequirementId] = React.useState('')
  const [project, setProject] = React.useState(projects.length === 1 ? projects[0].id : '')
  /* 默认挂「当前迭代」：以前每次都要手选，结果就是没人选 —— 真机上 36 张卡一张都没挂迭代，
     项目页的迭代进度永远是 0/0。这里取该项目的 active 迭代，只有一个迭代时也直接用。 */
  const activeIterationOf = id => {
    const list = projects.find(item => item.id === id)?.iterations ?? []
    const active = list.find(item => String(item.status ?? '') === 'active')
    return active?.id ?? (list.length === 1 ? list[0].id : '')
  }
  const [iteration, setIteration] = React.useState(() => activeIterationOf(projects.length === 1 ? projects[0].id : ''))
  const [owner, setOwner] = React.useState('')
  const [due, setDue] = React.useState('')
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const isBug = type === 'bug'
  const projectIterations = (projects.find(item => item.id === project)?.iterations ?? [])
  const submit = async () => {
    setBusy(true); setError(null)
    try {
      await api('/task/create', {
        title, requirement, type, priority, domain,
        severity: isBug ? severity : '',
        role: isBug ? 'dev' : 'product',
        status: isBug ? 'dev_ready' : 'clarify',
        project, iteration: project === '' ? '' : iteration,
        owner: owner.trim(), dueAt: fromDateInput(due),
        requirementId,
      })
      await onCreated()
      onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const fieldOf = (label, control) => h('div', { className: FIELD }, h('div', { className: LABEL }, label), control)
  return h('div', { className: OVERLAY, style: OVERLAY_STYLE, 'data-dialog': 'new-task', onClick: e => { if (e.target === e.currentTarget) onClose() } },
    h('div', { className: CARD, role: 'dialog', 'aria-modal': 'true', 'aria-label': isBug ? '登记缺陷' : '新建任务', 'data-dialog-card': '' },
      h('h3', { className: HEAD }, isBug ? '登记缺陷' : '新建任务'),
      fieldOf('标题', h(TextField, {
        'aria-label': '标题', autoFocus: true,
        placeholder: isBug ? '一句话说清什么坏了，例如「优惠券叠加后金额算错」' : '一句话说清要做什么',
        value: title,
        onChange: e => setTitle(e.target.value),
        onKeyDown: e => { if (e.key === 'Enter' && !e.isComposing) void submit() },
      })),
      fieldOf(isBug ? '复现步骤 / 现象' : '需求 / 背景', h(MdField, {
        'aria-label': isBug ? '复现步骤 / 现象' : '需求 / 背景', rows: 5,
        placeholder: isBug
          ? '复现步骤：1… 2…\n实际结果：\n期望结果：\n影响范围 / 环境（版本、账号、数据条件）：'
          : '背景、期望结果、验收口径。专家会照这段去开工。',
        value: requirement, onChange: e => setRequirement(e.target.value),
      })),
      h('div', { className: GRID },
        fieldOf('类型', h(SelectField, { 'aria-label': '类型', value: type, onChange: e => setType(e.target.value) },
          Object.keys(TYPE_LABEL).map(v => h('option', { key: v, value: v }, TYPE_LABEL[v])))),
        isBug
          ? fieldOf('严重级别', h(SelectField, { 'aria-label': '严重级别', value: severity, onChange: e => setSeverity(e.target.value) },
            Object.keys(SEVERITY_LABEL).map(v => h('option', { key: v, value: v }, SEVERITY_LABEL[v]))))
          : fieldOf('优先级', h(SelectField, { 'aria-label': '优先级', value: priority, onChange: e => setPriority(e.target.value) },
            Object.keys(PRIORITY_LABEL).map(v => h('option', { key: v, value: v }, PRIORITY_LABEL[v])))),
        isBug
          ? fieldOf('优先级', h(SelectField, { 'aria-label': '优先级', value: priority, onChange: e => setPriority(e.target.value) },
            Object.keys(PRIORITY_LABEL).map(v => h('option', { key: v, value: v }, PRIORITY_LABEL[v]))))
          : null,
        h('div', { className: FIELD + ' ' + FULL },
          h('div', { className: LABEL }, '挂在哪个需求下'),
          requirements.length === 0
            ? h('div', { className: HINT }, '还没有需求。到「需求」页先建一条，这张卡就能拿到 DEV-001 这样的编号。')
            : h(SelectField, { 'aria-label': '挂在哪个需求下', value: requirementId, onChange: e => setRequirementId(e.target.value) },
              h('option', { value: '' }, isBug ? '暂不挂需求（缺陷可以不挂）' : (requirements.length === 0 ? '还没有需求：先到「需求」页建一条' : '请选择需求（必填）')),
              requirements.map(item => h('option', { key: item.id, value: item.id }, `${item.code || item.id} · ${item.title}`)),
            ),
        ),
        h('div', { className: FIELD + ' ' + FULL },
          h('div', { className: LABEL }, '业务领域（选填）'),
          h(TextField, {
            'aria-label': '业务领域', placeholder: '例如 支付 / 会员 / 履约，填了会自动派给同领域的专家',
            value: domain, onChange: e => setDomain(e.target.value),
          }),
        ),
        projects.length === 0
          ? null
          : fieldOf('业务项目', h(SelectField, {
            'aria-label': '业务项目', value: project,
            onChange: e => { setProject(e.target.value); setIteration(activeIterationOf(e.target.value)) },
          },
            h('option', { value: '' }, '不属于任何项目'),
            projects.map(item => h('option', { key: item.id, value: item.id }, `${item.key ? `${item.key} · ` : ''}${item.name}`)),
          )),
        projects.length === 0 || projectIterations.length === 0
          ? null
          : h('div', { className: FIELD },
            h('div', { className: LABEL }, '迭代'),
            h(SelectField, { 'aria-label': '迭代', value: iteration, onChange: e => setIteration(e.target.value) },
              h('option', { value: '' }, '不指定迭代'),
              projectIterations.map(item => h('option', { key: item.id, value: item.id }, item.name))),
            h('div', { className: HINT }, '默认挂这个项目的当前迭代，可以改'),
          ),
        fieldOf('业务负责人（选填）', h(TextField, {
          'aria-label': '业务负责人', placeholder: '提需求的人，例如 张伟',
          value: owner, onChange: e => setOwner(e.target.value),
        })),
        fieldOf('期望完成（选填）', h(DateField, { 'aria-label': '期望完成', value: due, onChange: e => setDue(e.target.value) })),
      ),
      isBug
        ? h('div', { className: HINT }, '缺陷卡会直接落到「待开发」，由研发先复现、定位根因再修，修完自动交给测试验证。')
        : null,
      h('div', { className: FOOT },
        error !== null ? h('span', { className: 'text-caption-1-regular text-text-error-primary' }, error) : null,
        h('div', { className: 'flex-1' }),
        h(Button, { variant: 'secondary', size: 'sm', 'data-action': 'cancel', onClick: onClose }, '取消'),
        h(Button, { variant: 'primary', size: 'sm', 'data-action': 'submit', disabled: busy || title.trim() === '' || (!isBug && requirementId === ''), onClick: () => void submit() },
          busy ? '创建中…' : (isBug ? '登记缺陷' : '创建')),
      ),
    ),
  )
}
