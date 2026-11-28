/* Settings panels lifted out of client.src.js; shared handles come from the studio context.
 *
 * 面板内部已经全部换成 BoardUI（Tailwind v4 token + 4px 档位），不再用手写类：
 *   - 分区 = 卡片：rounded-xl + border-separator-border + bg-background-primary-default + p-4
 *   - 小节标题 text-title-2-semibold、说明 text-caption-1-regular text-text-tertiary
 *   - 行 = 分隔线（1px + 末行去掉），动作用 BoardUI Button，状态用 Chip
 *   - 审计日志用官方 Table + Pagination（真 <table> 语义，键盘可达）
 *   - 空态用 boardui/empty-state
 *
 * 最外层容器是纯 Tailwind（设置页外壳已迁 BoardUI），不再借旧的 panel 类过渡。
 * 探针靠 data-* 钩子（data-design-gate / data-review-gate / data-case-gate / data-isolation-warning），
 * 不依赖样式类名。
 */

import { statusDot, uiIcon } from '../icons.js'
import { ROLE_LABEL, ACCESS_ROLE_OPTIONS, STRATEGIES, ROUTE_LABEL } from '../labels.js'
import { buildRoster, filterRoster } from '../roster.js'
import { fmtTime } from '../format.js'
import { client } from '../context.js'
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell } from '../../components/base/table/table'
import { Pagination } from '../../components/base/pagination/pagination'
import { Button } from '../../boardui/index'
import { EmptyState } from '../../boardui/empty-state'

const PANE = 'flex min-w-0 flex-col gap-3'
const SECTION = 'flex min-w-0 flex-col gap-3 rounded-xl border border-separator-border bg-background-primary-default p-4'
const SECTION_HEAD = 'flex flex-wrap items-start justify-between gap-3'
const SECTION_TITLE = 'text-title-2-semibold text-text-primary'
const DESC = 'text-caption-1-regular text-text-tertiary'
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
const KV_ROW = 'flex min-w-0 items-baseline justify-between gap-3 border-b border-dashed border-separator-border py-1 last:border-b-0'

export function AccessPanel({ state, config, onChanged }) {
  const { h, sessionToken, api, apiBase, toast, currentUser, confirmDialog, TextField, ChipField, CheckField, SwitchToggle, SelectField , React } = client()
  const access = config.access ?? { enabled: false, members: [] }
  const audit = state.audit ?? []
  const [draft, setDraft] = React.useState({ name: '', role: 'member' })
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState(null)
  const [onlyBy, setOnlyBy] = React.useState('')
  const [onlyFailed, setOnlyFailed] = React.useState(false)
  const [queryText, setQueryText] = React.useState('')
  // 审计日志原来一次铺 120 行（600+ DOM 节点）。分页后每页 50 行。
  const [auditPage, setAuditPage] = React.useState(1)

  const act = async (path, body) => {
    setBusy(true); setNote(null)
    try {
      await api(path, body)
      await onChanged()
    } catch (cause) {
      { const detail = cause instanceof Error ? cause.message : String(cause); setNote(detail); toast(detail, 'error') }
    } finally { setBusy(false) }
  }

  const addMember = async () => {
    const name = draft.name.trim()
    if (name === '') return
    await act('/access/save', { member: { name, role: draft.role } })
    setDraft({ name: '', role: 'member' })
  }

  const people = Array.from(new Set(audit.map(item => item.by))).sort()
  const keyword = queryText.trim().toLowerCase()
  const matched = audit.filter(item => (onlyBy === '' || item.by === onlyBy)
    && (onlyFailed === false || item.ok === false)
    && (keyword === '' || `${ROUTE_LABEL[item.route] ?? item.route} ${item.by} ${item.summary}`.toLowerCase().includes(keyword)))
  const AUDIT_PAGE_SIZE = 25
  const rows = matched.slice(0, 500)
  const auditTotalPages = Math.max(1, Math.ceil(rows.length / AUDIT_PAGE_SIZE))
  const auditCurrent = Math.min(auditPage, auditTotalPages)
  const pageRows = rows.slice((auditCurrent - 1) * AUDIT_PAGE_SIZE, auditCurrent * AUDIT_PAGE_SIZE)

  // 走服务端导出：http 页面里的 blob 下载会被 Chrome 拦，服务端 Content-Disposition 才稳
  const exportCsv = () => {
    const params = new URLSearchParams({
      by: onlyBy, q: queryText.trim(), failed: onlyFailed ? '1' : '0',
      token: sessionToken() ?? '',
    })
    const anchor = document.createElement('a')
    anchor.href = `${apiBase}/audit/export.csv?${params.toString()}`
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    toast(`正在导出 ${matched.length} 条审计记录`)
  }

  return h('div', { className: PANE, 'data-panel': 'governance-access' },
    /* 宽屏两栏：成员 380px + 审计占满剩余。原来两段竖着排，一页 10 个成员就把审计日志推到 2000px 外。 */
    h('div', { className: 'grid min-w-0 gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]' },
    h('div', { className: SECTION, 'data-section': 'members' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '成员权限'),
          h('div', { className: DESC }, access.enabled === true
            ? '已启用：写操作要认人，删除/配置/发布要管理员。'
            : '未启用：任何人都是管理员（单机用法）。'),
        ),
        h(ChipField, { variant: 'gray' }, `当前身份：${currentUser()}`),
      ),
      h(SwitchToggle, {
        checked: access.enabled === true,
        disabled: busy,
        label: '启用成员权限',
        onChange: event => void act('/access/save', { enabled: event.target.checked }),
      }),
      access.enabled === true && (access.members ?? []).length === 0
        ? h('div', { className: ERR, role: 'alert' }, '已启用但名单是空的：除了名单里的人，其他人都动不了。先把你自己加进去。')
        : null,
      access.enabled === true
        ? h(SwitchToggle, {
            checked: (access.agents ?? 'inherit') === 'inherit',
            disabled: busy,
            label: 'AI 专家也受这份名单约束',
            onChange: event => void act('/access/save', { agents: event.target.checked ? 'inherit' : 'bypass' }),
          })
        : null,
      access.enabled === true
        ? h('div', { className: HINT }, (access.agents ?? 'inherit') === 'inherit'
            ? '专家调工具时按同一张名单判权限：只读专家只能看，成员能干活，管理员才能改配置。名单里没有的专家会被拦下，记得在下面加进去。'
            : '已豁免：专家调用工具不受名单限制，但仍记审计。适合「全交给 AI」的团队。')
        : null,
      (access.members ?? []).length === 0
        ? h(EmptyState, { title: '还没有成员。' })
        : h('div', { className: 'flex min-w-0 flex-col' }, (access.members ?? []).map(member => h('div', {
          key: member.name,
          className: LISTROW,
          'data-member-row': '',
        },
          h('div', { className: LISTROW_MAIN },
            h('div', { className: LISTROW_TITLE },
              h('span', { className: 'min-w-0 truncate' }, member.name),
              member.name === currentUser() ? h(ChipField, { variant: 'soft' }, '我') : null,
            ),
            h('div', { className: HINT }, (ACCESS_ROLE_OPTIONS.find(item => item.id === member.role) ?? ACCESS_ROLE_OPTIONS[1]).hint),
          ),
          h('div', { className: LISTROW_ACTIONS },
            h(SelectField, {
              size: 'md',
              value: member.role, disabled: busy,
              'aria-label': `成员 ${member.name} 的角色`,
              onChange: event => void act('/access/save', { member: { name: member.name, role: event.target.value } }),
            }, ACCESS_ROLE_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.label))),
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void act('/access/delete', { name: member.name }) }, '移除'),
          ),
        ))),
      h('div', { className: ROW },
        h(TextField, {
          placeholder: '成员名字（和页头「我是…」一致）', 'aria-label': '新成员名字', value: draft.name,
          style: { flex: '1 1 200px' },
          onChange: event => setDraft({ ...draft, name: event.target.value }),
        }),
        h(SelectField, {
          size: 'md',
          value: draft.role, style: { flex: '0 0 130px' }, 'aria-label': '新成员角色',
          onChange: event => setDraft({ ...draft, role: event.target.value }),
        }, ACCESS_ROLE_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.label))),
        h(Button, { variant: 'primary', size: 'sm', disabled: busy || draft.name.trim() === '', onClick: () => void addMember() }, '加成员'),
      ),
      note !== null ? h('div', { className: ERR, role: 'alert' }, note) : null,
    ),
    h('div', { className: SECTION, 'data-section': 'audit' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '审计日志'),
          h('div', { className: DESC }, `显示 ${rows.length} / 命中 ${matched.length} / 共 ${audit.length} 条`),
        ),
        h('div', { className: ROW },
          h(TextField, {
            placeholder: '搜动作 / 人 / 详情', 'aria-label': '搜审计日志',
            value: queryText, style: { width: 170 },
            onChange: event => setQueryText(event.target.value),
          }),
          h(SelectField, {
            size: 'md',
            value: onlyBy === '' ? '__all__' : onlyBy, style: { minWidth: 150 }, 'aria-label': '按操作人筛选',
            onChange: event => setOnlyBy(event.target.value === '__all__' ? '' : event.target.value),
          },
            h('option', { value: '__all__' }, '所有人'),
            people.map(name => h('option', { key: name, value: name }, name))),
          h(CheckField, { checked: onlyFailed, onChange: event => setOnlyFailed(event.target.checked) }, '只看失败'),
          h(Button, {
            variant: 'ghost', size: 'sm', disabled: busy,
            onClick: async () => { if (await confirmDialog('清空审计日志？清掉之后所有操作记录都没了。', { title: '清空审计日志', danger: true, okText: '清空' })) void act('/audit/clear', {}) },
          }, '清空'),
          h(Button, {
            variant: 'secondary', size: 'sm', disabled: matched.length === 0, onClick: exportCsv,
            title: '把当前筛选结果导出为 CSV（Excel 可直接打开）',
          }, '导出 CSV'),
        ),
      ),
      rows.length === 0
        ? h(EmptyState, { title: audit.length === 0
          ? '还没有记录。做一次写操作就会出现在这里。'
          : '没有符合筛选条件的记录。把关键字清空或换个人试试。' })
        : h('div', { className: 'flex min-w-0 flex-col gap-3' },
          // 官方 Table：真 <table> 语义（表头可被屏幕阅读器读到、行可用键盘导航），
          // 替代原来 120 个审计行 div 平铺。
          h(Table, { key: 'table', size: 'sm', 'aria-label': '审计日志' },
            h(TableHeader, null,
              h(TableColumn, { id: 'time', isRowHeader: true }, '时间'),
              h(TableColumn, { id: 'by' }, '操作人'),
              h(TableColumn, { id: 'what' }, '动作'),
              h(TableColumn, { id: 'detail' }, '详情'),
              h(TableColumn, { id: 'status' }, '结果'),
            ),
            h(TableBody, null,
              pageRows.map(item => h(TableRow, { key: item.id, id: item.id, 'data-ok': item.ok ? '1' : '0', 'data-audit-row': item.id },
                h(TableCell, null, fmtTime(item.at)),
                h(TableCell, null, item.by),
                h(TableCell, null, ROUTE_LABEL[item.route] ?? item.route),
                h(TableCell, null, item.summary),
                h(TableCell, null, item.ok ? '成功' : `失败 ${item.status}`),
              )),
            ),
          ),
          auditTotalPages > 1
            ? h('div', { key: 'pager', className: ROW_END },
              h(Pagination, {
                page: auditCurrent,
                totalPages: auditTotalPages,
                onChange: next => setAuditPage(next),
                'aria-label': '审计日志分页',
                previousLabel: '上一页',
                nextLabel: '下一页',
              }))
            : null,
        ),
    ),
    ),
  )
}

export function ColumnsPanel({ state, onChanged }) {
  const { h, sessionToken, api, toast, currentUser, confirmDialog, TextField, TextAreaField, ChipField, CheckField, SwitchToggle, SelectField , React } = client()
  const config = state.config
  const [error, setError] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  /* 缺陷 SLA（小时）与默认验收模板：与闸门同一页，因为它们都决定「卡怎么被收口」。 */
  const [slaDraft, setSlaDraft] = React.useState(() => ({
    p0: String(config.sla?.p0 ?? 4),
    p1: String(config.sla?.p1 ?? 24),
    p2: String(config.sla?.p2 ?? 72),
    p3: String(config.sla?.p3 ?? 168),
  }))
  const [slaNote, setSlaNote] = React.useState(null)
  const [templateDraft, setTemplateDraft] = React.useState(() => ({
    dev: (config.templates?.dev ?? []).join('\n'),
  }))
  const [templateNote, setTemplateNote] = React.useState(null)
  const saveSla = async () => {
    setBusy(true); setError(null); setSlaNote(null)
    try {
      const patch = {}
      for (const level of ['p0', 'p1', 'p2', 'p3']) {
        const value = Number(slaDraft[level])
        if (Number.isFinite(value) && value > 0) patch[level] = Math.round(value)
      }
      const out = await api('/config', { sla: patch })
      const saved = out?.state?.config?.sla ?? patch
      setSlaDraft({ p0: String(saved.p0), p1: String(saved.p1), p2: String(saved.p2), p3: String(saved.p3) })
      setSlaNote('已保存：超时按新时限算')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const saveTemplates = async () => {
    setBusy(true); setError(null); setTemplateNote(null)
    try {
      const items = String(templateDraft.dev ?? '').split('\n').map(line => line.trim()).filter(line => line !== '').slice(0, 12)
      const out = await api('/config', { templates: { ...(config.templates ?? {}), dev: items } })
      const saved = out?.state?.config?.templates?.dev ?? items
      setTemplateDraft({ dev: saved.join('\n') })
      setTemplateNote(`已保存：之后新建开发卡会带 ${saved.length} 条`)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const [openFor, setOpenFor] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const statuses = state.statuses ?? []
  const roster = React.useMemo(() => buildRoster(config), [config])

  const membersOf = status => {
    const owner = config.columns?.[status]
    if (owner === undefined || owner === null) return []
    if (Array.isArray(owner.members)) return owner.members
    if (owner.kind === 'none') return []
    return [{ kind: owner.kind, id: owner.id }]
  }
  const strategyOf = status => config.columns?.[status]?.strategy ?? 'round_robin'
  const labelOf = member => {
    if (member.kind === 'role') return ROLE_LABEL[member.id] ?? String(member.id ?? '')
    if (member.kind === 'team') {
      const team = (config.teams ?? []).find(entry => entry.id === member.id)
      return team === undefined ? String(member.id ?? '') : team.name
    }
    const expert = (config.experts ?? []).find(entry => entry.id === member.id)
    return expert === undefined ? String(member.id ?? '') : expert.name
  }
  // 设计闸门：开关 + 勾哪几列要拦。存的是 config.design，服务端 designGate() 用它。
  const gateColumns = Array.isArray(config.design?.columns) ? config.design.columns : ['dev']
  const saveDesign = async patch => {
    setBusy(true); setError(null)
    try {
      await api('/config', { design: { ...(config.design ?? {}), ...patch } })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  // 评审闸门：默认开（只有显式 false 才算关）。存 config.reviewGate，服务端 quality.js 的 reviewGate() 用它。
  const reviewColumns = Array.isArray(config.reviewGate?.columns) && config.reviewGate.columns.length > 0 ? config.reviewGate.columns : ['test']
  const reviewEnabled = config.reviewGate?.enabled !== false
  const saveReview = async patch => {
    setBusy(true); setError(null)
    try {
      await api('/config', { reviewGate: { ...(config.reviewGate ?? {}), ...patch } })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  // 用例闸门：代码/测试类的卡一条用例都没有时不许收口（默认开）。存 config.caseGate，服务端 executor.js 用它。
  const caseGateEnabled = config.caseGate?.enabled !== false
  const saveCaseGate = async enabled => {
    setBusy(true); setError(null)
    try {
      await api('/config', { caseGate: { ...(config.caseGate ?? {}), enabled } })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  /* 三层测试闸门（单独一个开关）：代码类卡上单元/集成/端到端每条线要么有可执行用例，
     要么在测试计划里写明「不适用 + 理由」。存量卡补齐前会拦，想先放行就关这一条。 */
  const tierGateEnabled = config.caseGate?.tiers !== false
  const saveTierGate = async tiers => {
    setBusy(true); setError(null)
    try {
      await api('/config', { caseGate: { ...(config.caseGate ?? {}), tiers } })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  /* 拆卡闸门：功能点没有可判定验收条件时不许拆（产品这一棒的质量底线）。 */
  const acceptanceGateEnabled = config.requirementGate?.requireAcceptance !== false
  const saveAcceptanceGate = async requireAcceptance => {
    setBusy(true); setError(null)
    try {
      await api('/config', { requirementGate: { ...(config.requirementGate ?? {}), requireAcceptance } })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const toggleGateColumn = id => {
    const next = gateColumns.includes(id) ? gateColumns.filter(item => item !== id) : [...gateColumns, id]
    void saveDesign({ columns: next })
  }
  const save = async (status, members, strategy) => {
    setBusy(true); setError(null)
    try {
      /* 改列负责人不只是改配置：列 owner 一旦能解析，下一轮 tick（5 秒后）就把存量卡派出去。
         先 dryRun 问一次「会让哪些卡被带走」，有就让人确认；真落库后再把结果写在面板上
         （issue #149 现象二：调组织架构本身就有业务后果）。 */
      const preview = await api('/columns/save', { status, members, strategy, dryRun: true })
      const affected = preview?.affected
      const count = Number(affected?.cards?.filter(card => card.willDispatch).length ?? 0)
      if (count > 0) {
        const title = statuses.find(column => column.id === status)?.label ?? status
        const ok = await confirmDialog(
          preview.warning || `这次改动会让 ${count} 张卡在下一轮自动派单里被派给新的负责人`,
          { title: `改「${title}」的负责人`, okText: `继续（会派 ${count} 张）` },
        )
        if (ok !== true) { setBusy(false); return }
      }
      const out = await api('/columns/save', { status, members, strategy })
      const dispatched = Number(out?.affected?.cards?.filter(card => card.willDispatch).length ?? 0)
      setNotice(dispatched > 0
        ? `已保存：下一轮自动派单会派走 ${dispatched} 张卡（${out.affected.cards.filter(card => card.willDispatch).slice(0, 5).map(card => card.code || card.id).join('、')}${dispatched > 5 ? ' 等' : ''}）`
        : '已保存')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const add = (status, item) => {
    const kind = item.key.startsWith('t:') ? 'team' : item.key.startsWith('r:') ? 'role' : 'expert'
    const id = item.key.slice(2)
    const current = membersOf(status)
    if (current.some(member => member.kind === kind && member.id === id)) { return }
    setQuery('')
    void save(status, [...current, { kind, id }], strategyOf(status))
  }
  const remove = (status, index) => void save(status, membersOf(status).filter((_, i) => i !== index), strategyOf(status))

  return h('div', { className: PANE, 'data-panel': 'governance-columns' },
    h('div', { className: SECTION, 'data-section': 'gates' },
      h('div', { className: SECTION_TITLE }, '派活闸门'),
      h('div', { className: HINT }, '设计闸门：打开后，卡片进下面选中的列之前设计必须评审通过（验收时可 override 强推）。'),
      h('div', { className: ROW },
        h(Button, {
          variant: config.design?.enabled !== false ? 'primary' : 'secondary', size: 'sm',
          disabled: busy, 'data-design-gate': config.design?.enabled !== false ? 'on' : 'off',
          onClick: () => void saveDesign({ enabled: config.design?.enabled === false }),
        }, config.design?.enabled !== false ? '设计闸门：已开启' : '设计闸门：已关闭'),
        statuses.map(column => h(Button, {
          key: 'gate-' + column.id,
          variant: gateColumns.includes(column.id) ? 'primary' : 'secondary', size: 'sm',
          disabled: busy,
          onClick: () => toggleGateColumn(column.id),
        }, column.label ?? column.id)),
      ),
      h('div', { className: HINT },
        '评审闸门：进「待测试」之前代码评审必须有结论（默认开启）。关掉意味着卡可以跳过评审直接进测试——',
        '设置页这里会显示「已关闭」，看板顶部也会挂一条提示，避免看起来像有保护。'),
      h('div', { className: ROW },
        h(Button, {
          variant: reviewEnabled ? 'primary' : 'secondary', size: 'sm',
          disabled: busy, 'data-review-gate': reviewEnabled ? 'on' : 'off',
          onClick: () => void saveReview({ enabled: !reviewEnabled }),
        }, reviewEnabled ? '评审闸门：已开启' : '评审闸门：已关闭'),
        statuses.map(column => h(Button, {
          key: 'rgate-' + column.id,
          variant: reviewColumns.includes(column.id) ? 'primary' : 'secondary', size: 'sm',
          disabled: busy,
          onClick: () => void saveReview({ columns: reviewColumns.includes(column.id) ? reviewColumns.filter(item => item !== column.id) : [...reviewColumns, column.id] }),
        }, column.label ?? column.id)),
      ),
      h('div', { className: HINT },
        '用例闸门：代码/测试类的卡（开发 / 测试 / 缺陷）一条测试用例都没有时，不允许收口（默认开启）。',
        '关掉意味着这类卡可以零用例直接验收 —— 真机上曾经 20 张到过验收的卡里有 6 张零用例，门禁一次通过率 91%。'),
      h('div', { className: ROW },
        h(Button, {
          variant: caseGateEnabled ? 'primary' : 'secondary', size: 'sm',
          disabled: busy, 'data-case-gate': caseGateEnabled ? 'on' : 'off',
          onClick: () => void saveCaseGate(!caseGateEnabled),
        }, caseGateEnabled ? '用例闸门：已开启' : '用例闸门：已关闭'),
      ),
      h('div', { className: HINT },
        '三层测试闸门：代码/测试类卡上，单元 / 集成 / 端到端每条线要么有可执行的用例，要么在卡的「测试」页写明「不适用 + 理由」；缺一层不允许收口（默认开启）。',
        '存量卡会先被拦：补用例或写清哪一层验不了，再推进。'),
      h('div', { className: ROW },
        h(Button, {
          variant: tierGateEnabled ? 'primary' : 'secondary', size: 'sm',
          disabled: busy, 'data-tier-gate': tierGateEnabled ? 'on' : 'off',
          onClick: () => void saveTierGate(!tierGateEnabled),
        }, tierGateEnabled ? '三层测试闸门：已开启' : '三层测试闸门：已关闭'),
      ),
      h('div', { className: HINT },
        '拆卡闸门：需求的每个功能点至少要有一条**可判定**的验收条件（输入/操作 + 可观察结果），否则不允许拆成卡（默认开启）。',
        '没有验收条件的卡，研发只能猜、测试只能编，后面的门禁会空转。'),
      h('div', { className: ROW },
        h(Button, {
          variant: acceptanceGateEnabled ? 'primary' : 'secondary', size: 'sm',
          disabled: busy, 'data-requirement-gate': acceptanceGateEnabled ? 'on' : 'off',
          onClick: () => void saveAcceptanceGate(!acceptanceGateEnabled),
        }, acceptanceGateEnabled ? '拆卡验收条件闸门：已开启' : '拆卡验收条件闸门：已关闭'),
      ),
      error !== null ? h('div', { className: ERR, role: 'alert' }, error) : null,
    ),
    /* 缺陷 SLA 与默认验收模板：后端早就有（config.sla / config.templates），但没入口，
       想改只能 curl /config。SLA 决定工作台的「缺陷超时」，模板决定新建卡带哪些验收清单。 */
    h('div', { className: SECTION, 'data-section': 'sla-templates' },
      h('div', { className: SECTION_TITLE }, '缺陷 SLA 与默认验收清单'),
      h('div', { className: DESC }, 'SLA = 缺陷应修时限（小时），超时在工作台与卡面标红；默认验收清单是新建开发卡时自动带的条目，一行一条（≤12）。'),
      h('div', { className: ROW },
        ['p0', 'p1', 'p2', 'p3'].map(level => h('div', { key: level, className: 'flex min-w-0 flex-col gap-1', style: { flex: '0 1 120px' } },
          h('label', { className: 'text-caption-2-medium text-text-secondary' }, `${level.toUpperCase()} 小时内修完`),
          h(TextField, {
            'aria-label': `${level.toUpperCase()} 缺陷时限（小时）`,
            type: 'number',
            value: slaDraft[level],
            onChange: e => setSlaDraft({ ...slaDraft, [level]: e.target.value }),
          }),
        )),
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveSla() }, '保存 SLA'),
      ),
      slaNote === null ? null : h('div', { className: OK, role: 'status', 'data-sla-note': '' }, slaNote),
      h('div', { className: 'flex min-w-0 flex-col gap-1' },
        h('label', { className: 'text-caption-2-medium text-text-secondary' }, '开发卡的默认验收清单'),
        h(TextAreaField, {
          rows: 3,
          'aria-label': '开发卡的默认验收清单',
          placeholder: '一行一条，例如：改动的接口有可执行用例',
          value: templateDraft.dev,
          onChange: e => setTemplateDraft({ ...templateDraft, dev: e.target.value }),
        }),
        h('div', { className: ROW },
          h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveTemplates() }, '保存模板'),
          templateNote === null ? null : h('div', { className: HINT, role: 'status', 'data-template-note': '' }, templateNote),
        ),
      ),
    ),
    notice !== null ? h('div', { className: OK, role: 'status', 'data-column-notice': '1' }, notice) : null,
    h('div', { className: SECTION, 'data-section': 'column-owners' },      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '每一列由谁负责'),
          h('div', { className: DESC }, '推荐挂「角色位」：派单时按业务领域自动挑专家（如支付产品经理）；也可指定专家或专家团。一列可挂多人（候选池），都不挂就停在原地等认领。'),
        ),
      ),
      statuses.map(column => {
        const members = membersOf(column.id)
        const strategy = strategyOf(column.id)
        return h('div', {
          key: column.id,
          className: 'flex min-w-0 flex-col gap-2 rounded-lg border border-separator-border p-3',
          'data-column-row': column.id,
        },
          h('div', { className: ROW },
            h('span', { className: 'min-w-0 text-body-2-semibold text-text-primary' }, column.label ?? column.id),
            members.length === 0
              ? h('span', { className: HINT }, '等人认领（不自动派）')
              : members.map((member, index) => h(ChipField, { variant: 'gray', key: `${member.kind}:${member.id}` },
                labelOf(member),
                h(Button, {
                  variant: 'ghost', size: 'xs', title: '从候选里去掉',
                  'aria-label': `从 ${column.label ?? column.id} 的候选里去掉 ${labelOf(member)}`,
                  disabled: busy,
                  onClick: () => remove(column.id, index),
                }, '×'),
              )),
            h('div', { className: 'ml-auto flex min-w-0 flex-wrap items-center gap-2' },
              h(Button, {
                variant: 'secondary', size: 'sm', disabled: busy,
                onClick: () => { setQuery(''); setOpenFor(current => current === column.id ? null : column.id) },
              }, openFor === column.id ? '收起' : '加候选'),
              members.length >= 2
                ? h(SelectField, {
                  size: 'md',
                  value: strategy, disabled: busy, style: { width: 240 },
                  'aria-label': `${column.label ?? column.id} 的派单策略`,
                  onChange: e => void save(column.id, members, e.target.value),
                }, STRATEGIES.map(entry => h('option', { key: entry.id, value: entry.id }, entry.label)))
                : null,
            ),
          ),
          openFor === column.id
            ? h('div', { className: 'flex min-w-0 flex-col gap-2 rounded-lg border border-separator-border bg-background-secondary-default p-2' },
              h(TextField, {
                autoFocus: true, value: query,
                placeholder: '搜专家或专家团，点一下加进候选',
                onChange: e => setQuery(e.target.value),
              }),
              h('div', { className: 'flex max-h-56 min-w-0 flex-col overflow-y-auto' },
                filterRoster(roster, query).length === 0
                  ? h(EmptyState, { title: '没有匹配的专家或专家团' })
                  : filterRoster(roster, query).map(item => h(Button, {
                    key: item.key, variant: 'ghost', size: 'sm',
                    onClick: () => add(column.id, item),
                  }, item.icon === undefined ? null : uiIcon(h, item.icon), h('span', null, item.name), h('span', { className: 'text-caption-1-regular text-text-tertiary' }, item.hint))),
              ),
            )
            : null,
        )
      }),
    ),
  )
}

/** 数据与备份：看台账存在哪、密钥在哪，以及回滚到某个快照。 */
export function StoragePanel({ state, onChanged }) {
  const { h, sessionToken, api, toast, currentUser, confirmDialog, TextField, ChipField, CheckField, SwitchToggle, SelectField , React } = client()
  const [info, setInfo] = React.useState(state.storage ?? null)
  const [snapshots, setSnapshots] = React.useState([])
  const [error, setError] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(() => {
    api('/snapshots')
      .then(out => {
        setInfo(out.storage ?? null)
        setSnapshots(out.snapshots ?? [])
        setError(null)
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  React.useEffect(() => { load() }, [load, state.revision])

  const restore = async id => {
    if (!(await confirmDialog(`把看板回滚到快照 #${id}？当前的这一版会先另存一份，不会丢。`, { title: '回滚快照', okText: '回滚' }))) return
    setBusy(true)
    setNotice(null)
    api('/snapshot/restore', { id })
      .then(() => { setNotice(`已回滚到快照 #${id}`); load(); onChanged?.() })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const when = at => {
    const date = new Date(Number(at) || 0)
    return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
  }

  const kv = (label, value) => h('div', { className: KV_ROW },
    h('span', { className: LABEL }, label),
    h('b', { className: 'min-w-0 break-all text-body-2-medium text-text-primary' }, value),
  )

  return h('div', { className: PANE, 'data-panel': 'governance-storage' },
    h('div', { className: SECTION, 'data-section': 'ledger' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: SECTION_TITLE }, '台账存储'),
        h(ChipField, { variant: 'gray', 'data-on': info?.engine === 'sqlite' ? '1' : '0' }, info?.engine === 'sqlite' ? 'SQLite' : '单文件'),
      ),
      kv('数据文件', info?.db ?? '—'),
      kv('密钥文件（600 权限，明文不进台账）', info?.secretsFile ?? '—'),
      kv('保留快照', `${info?.snapshots ?? 0} / ${info?.snapshotLimit ?? 0}`),
      h('div', { className: HINT }, '每次写操作都会在同一个事务里先存一份快照，再更新台账；多进程同时写会排队（busy_timeout 5s），不会互相覆盖。'),
    ),
    h('div', { className: SECTION, 'data-section': 'snapshots' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '快照'),
          h('div', { className: DESC }, '回滚前会把当前这一版先另存一份，不会丢东西'),
        ),
        h(Button, { variant: 'ghost', size: 'sm', onClick: load, disabled: busy }, '刷新'),
      ),
      notice !== null ? h('div', { className: OK, role: 'status' }, notice) : null,
      error !== null ? h('div', { className: ERR, role: 'alert' }, error) : null,
      snapshots.length === 0
        ? h(EmptyState, { title: info?.engine === 'sqlite' ? '还没有快照。' : '单文件模式没有快照（这台机器的 node 不支持 node:sqlite 时会退回单文件）。' })
        : h('div', { className: 'flex min-w-0 flex-col' }, snapshots.map(item => h('div', { key: item.id, className: LISTROW, 'data-snapshot-row': '' },
          h('div', { className: LISTROW_MAIN },
            h('div', { className: LISTROW_TITLE }, `#${item.id} · rev ${item.revision}`),
            h('div', { className: HINT }, `${when(item.at)} · ${(item.bytes / 1024).toFixed(1)} KB`),
          ),
          h('div', { className: LISTROW_ACTIONS },
            h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => restore(item.id), 'data-warn': '1', title: '用这个快照覆盖当前台账；覆盖前会先把当前版本另存一份' }, '回滚到这版'),
          ),
        ))),
    ),
  )
}

/** 集成健康：哪条通道在掉、什么时候掉的、还能不能补一次。 */
export function HealthPanel({ state, config, onChanged }) {
  const { h, sessionToken, api, apiBase, toast, currentUser, confirmDialog, TextField, ChipField, CheckField, SwitchToggle, SelectField , React } = client()
  const health = state.integrations ?? { channels: [], broken: 0 }
  const [busy, setBusy] = React.useState('')
  const [note, setNote] = React.useState(null)
  const firstRequirement = (state.requirements ?? []).find(item => (item.folder?.token ?? '') !== '')
  /* 派单锁与派单日志在 GET /agents（dispatcher.status()）里，**不在 /state**。
     以前这里读 state.agents，永远是 undefined —— 于是锁信息不显示、日志区永远写着
     「还没有派单日志」。改成挂载时拉一次，并给一个手动刷新入口。 */
  const [agents, setAgents] = React.useState({})
  const loadAgents = React.useCallback(async () => {
    try {
      const out = await api('/agents')
      setAgents(out.ok === false ? {} : out)
    } catch { setAgents({}) }
  }, [api])
  React.useEffect(() => { void loadAgents() }, [loadAgents])
  const lock = agents.lock ?? null
  const lockAge = lock === null ? 0 : Math.max(0, Date.now() - (Number(lock.at) || 0))
  const [logQuery, setLogQuery] = React.useState('')
  const [logFailed, setLogFailed] = React.useState(false)
  const logKeyword = logQuery.trim().toLowerCase()
  const logRows = (agents.log ?? []).filter(entry => {
    const line = String(entry?.line ?? '')
    if (logFailed && !/失败|错误|异常|拦|拒绝/.test(line)) return false
    return logKeyword === '' || line.toLowerCase().includes(logKeyword)
  })
  const logShown = logRows.slice(0, 12)
  const exportLogCsv = () => {
    const params = new URLSearchParams({
      q: logQuery.trim(), failed: logFailed ? '1' : '0', token: sessionToken() ?? '',
    })
    const anchor = document.createElement('a')
    anchor.href = `${apiBase}/export/dispatch.csv?${params.toString()}`
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    toast(`正在导出 ${logRows.length} 条派单日志`)
  }

  const retry = async channel => {
    setBusy(channel); setNote(null)
    try {
      if (channel === 'gitlab') {
        const out = await api('/gitlab/sync', {})
        /* 路由回的是 summary（不是 report）：以前读 out.report 永远是 undefined，
           于是「同步完了新增了几张卡」从来没显示过。现在把每个项目的结果说清。 */
        const rows = Array.isArray(out.summary?.projects) ? out.summary.projects : []
        const created = rows.reduce((sum, item) => sum + (Number(item.created) || 0), 0)
        const failed = rows.filter(item => item.error !== undefined)
        const done = rows.filter(item => item.error === undefined)
        const partial = out.summary?.partial === true
          ? `；本轮预算内只跑了 ${rows.length} 个，剩下 ${(out.summary.skippedProjects ?? []).join('、')} 下一轮继续`
          : ''
        setNote(rows.length === 0
          ? '没有可同步的项目（先配好地址 / 项目路径 / 令牌）'
          : `已同步 ${done.length} 个项目，新建 ${created} 张卡${failed.length > 0 ? `；${failed.length} 个失败：${failed.map(item => `${item.name || item.project}（${item.error}）`).join('、')}` : ''}${partial}`)
      } else if (channel === 'drive') {
        if (firstRequirement === undefined) {
          setNote('还没有带云盘文件夹的需求，先建一条需求并归档一次。')
        } else {
          const out = await api('/requirement/sync', { id: firstRequirement.id })
          setNote(`已归档 ${out.report?.written ?? 0} / ${out.report?.total ?? 0} 件`); toast(`已归档 ${out.report?.written ?? 0} / ${out.report?.total ?? 0} 件`)
        }
      } else if (channel === 'feishu') {
        const out = await api('/feishu/test', {})
        /* 路由回的是 results 数组（每台机器人一条）。以前读 out.result?.error（单数），
           于是配了机器人但发送失败时永远显示「没配置机器人」，真实失败原因看不到。 */
        const rows = Array.isArray(out.results) ? out.results : []
        if (rows.length === 0) {
          setNote('还没有配置飞书机器人：设置 → 飞书机器人里加一个 Webhook')
        } else {
          const ok = rows.filter(row => row.ok === true)
          const bad = rows.filter(row => row.ok !== true)
          setNote(ok.length > 0
            ? `测试消息已发出：${ok.map(row => row.name || row.bot).join('、')}${bad.length > 0 ? `；${bad.length} 个失败：${bad.map(row => `${row.name || row.bot}（${row.error ?? '未知原因'}）`).join('、')}` : ''}`
            : `发送失败：${bad.map(row => `${row.name || row.bot}（${row.error ?? '检查 Webhook'}）`).join('、')}`)
        }
      } else if (channel === 'webhook') {
        /* 出站 webhook 没有「补发」接口，但也不能拿「代码隔离」的文案糊弄人。 */
        setNote('出站 webhook 不单独重发：下一批事件（卡变动 / 缺陷 / 发布）会自动再投一次；连续失败请检查接收端地址')
      } else {
        setNote('代码隔离没有独立的重试入口，下一张卡派单时会自动重试。')
      }
      await onChanged()
    } catch (cause) {
      { const detail = cause instanceof Error ? cause.message : String(cause); setNote(detail); toast(detail, 'error') }
    } finally {
      setBusy('')
    }
  }

  const when = at => {
    const value = Number(at) || 0
    if (value === 0) return '—'
    const date = new Date(value)
    return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }

  const STATE_LABEL = { ok: '正常', error: '异常', idle: '还没用过' }

  const kv = (label, node) => h('div', { className: 'flex min-w-0 flex-col gap-1 md:flex-row md:items-baseline md:gap-3' },
    h('dt', { className: 'shrink-0 text-caption-1-medium text-text-tertiary' }, label),
    h('dd', { className: 'm-0 min-w-0 break-all text-body-2-regular text-text-primary' }, node),
  )

  return h('div', { className: PANE, 'data-panel': 'governance-health' },
    h('div', { className: SECTION, 'data-section': 'dispatch' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '派单运行状态'),
          h('div', { className: DESC }, '卡进入自动列后，派单、空闲、失败都记在这里'),
        ),
        h('div', { className: ROW },
          h(ChipField, { variant: 'gray', 'data-on': agents.enabled === true ? '1' : '0' }, agents.enabled === true ? '运行中' : '已停用'),
          h(TextField, {
            placeholder: '搜派单日志', 'aria-label': '搜派单日志',
            value: logQuery, style: { width: 150 },
            onChange: event => setLogQuery(event.target.value),
          }),
          h(CheckField, { checked: logFailed, onChange: event => setLogFailed(event.target.checked) }, '只看失败'),
          h(Button, { variant: 'ghost', size: 'sm', 'data-agent-log-refresh': '', onClick: () => void loadAgents() }, '刷新日志'),
          h(Button, {
            variant: 'ghost', size: 'sm', disabled: logRows.length === 0, onClick: exportLogCsv,
            title: '把当前筛选结果导出为 CSV',
          }, '导出 CSV'),
        ),
      ),
      h('dl', { className: 'm-0 flex min-w-0 flex-col gap-2' },
        kv('实例', String(agents.instance ?? '—')),
        kv('派单锁', lock === null
          ? '还没抢到过（可能是内存模式）'
          : `${lock.mine === true ? '本进程持有' : '其他实例持有'} · ${Math.round(lockAge / 1000)} 秒前续租`),
        kv('并发占用', String(agents.isolationWarning ?? '') === ''
          ? `${(agents.running ?? []).length} / ${agents.maxConcurrent ?? '—'}`
          : `${(agents.running ?? []).length} / ${agents.effectiveMaxConcurrent ?? 1}（配置 ${agents.maxConcurrent ?? '—'}，已降级）`),
        kv('最近一轮', when(agents.lastTickAt)),
        kv('最近错误', String(agents.lastError ?? '') === '' ? '无' : String(agents.lastError)),
      ),
      String(agents.isolationWarning ?? '') === '' ? null : h('div', { className: 'rounded-lg border border-separator-border bg-background-secondary-default p-2' },
        h('div', { className: ERR, 'data-isolation-warning': '1' }, String(agents.isolationWarning))),
      (agents.log ?? []).length === 0
        ? h(EmptyState, { title: '还没有派单日志。卡进入自动列后，这里会出现派单、空闲、失败记录。' })
        : logShown.length === 0
          ? h(EmptyState, { title: '没有符合筛选条件的派单日志。' })
          : h('div', { className: 'flex max-h-64 min-w-0 flex-col gap-1 overflow-y-auto rounded-xl border border-separator-border bg-background-secondary-default p-2', 'data-dispatch-log': '' },
            logShown.map((entry, index) => h('div', {
              key: String(index),
              className: 'font-mono text-caption-1-regular text-text-secondary',
            }, `${when(entry.at)} · ${String(entry.line ?? '')}`)),
          ),
      (agents.log ?? []).length > 0 && logRows.length > logShown.length
        ? h('div', { className: HINT }, `只显示最近 ${logShown.length} / 命中 ${logRows.length} 条，导出可看全量`)
        : null,
    ),
    h('div', { className: SECTION, 'data-section': 'integrations' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '集成状态'),
          h('div', { className: DESC }, '哪条通道在掉、什么时候掉的、还能不能补一次'),
        ),
        h('div', { className: ROW },
          h(ChipField, { variant: 'gray', 'data-on': health.broken === 0 ? '1' : '0' },
            health.broken === 0 ? '全部正常' : `${health.broken} 条异常`),
          h(Button, { variant: 'secondary', size: 'sm', onClick: () => void onChanged() }, '刷新'),
        ),
      ),
      note !== null ? h('div', { className: HINT, role: 'status' }, note) : null,
      health.channels.length === 0
        ? h(EmptyState, { title: '还没有调用过任何外部集成。配好 GitLab / 飞书机器人 / 云盘文件夹后，第一次成功或失败就会出现在这里。' })
        : h('div', { className: 'flex min-w-0 flex-col' }, health.channels.map(item => h('div', { key: item.channel, className: LISTROW, 'data-channel-row': item.channel },
          h('div', { className: LISTROW_MAIN },
            h('div', { className: LISTROW_TITLE },
              statusDot(h, item.state === 'ok' ? 'ok' : item.state === 'error' ? 'danger' : 'idle'),
              h('span', { className: 'min-w-0 truncate' }, item.label),
              h(ChipField, { variant: 'soft' }, STATE_LABEL[item.state]),
            ),
            h('div', { className: HINT }, item.hint),
            h('div', { className: HINT },
              `最近一次：${when(item.at)} · 成功 ${when(item.lastOkAt)} · 失败 ${when(item.lastErrorAt)}${item.attempts > 0 ? ` · 试着调了 ${item.attempts} 次，连挂 ${item.failures} 次` : ''}`),
            item.lastError === '' ? null : h('div', { className: ERR }, item.lastError),
          ),
          h('div', { className: LISTROW_ACTIONS },
            h(Button, {
              variant: 'secondary', size: 'sm', disabled: busy !== '',
              onClick: () => void retry(item.channel),
            }, busy === item.channel ? '重试中…' : '再试一次'),
          ),
        ))),
    ),
    h('div', { className: SECTION, 'data-section': 'failure-policy' },
      h('div', { className: SECTION_TITLE }, '失败了会怎样'),
      h('div', { className: HINT }, '飞书通知：同一条消息会自动重发一次，两次都失败才记异常（飞书 200 但 body 里 code≠0 也算失败）。'),
      h('div', { className: HINT }, 'GitLab：拉 Issue、回写评论、对 MR 失败会记在这里；同步定时器仍会自动重试下一轮。'),
      h('div', { className: HINT }, '飞书云盘：归档失败会挂在交付物自身的 doc.error 上，这里再汇总一份。'),
      h('div', { className: HINT }, '代码隔离：worktree 建失败只影响这一张卡（退回普通工作区），不影响别的卡。'),
    ),
  )
}
