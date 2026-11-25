/* Settings panels lifted out of client.src.js; shared handles come from the studio context.
 *
 * 面板内部已经全部换成 BoardUI（Tailwind v4 token + 4px 档位），不再用手写类：
 *   - 分区 = 卡片：rounded-xl + border-separator-border + bg-background-primary-default + p-4
 *   - 小节标题 text-title-2-semibold、说明 text-caption-1-regular text-text-tertiary
 *   - 行 = 分隔线（1px + 末行去掉），动作用 BoardUI Button，状态用 Chip
 *   - 空态用 boardui/empty-state；列表分区不再走共享 Editor（旧的 panel 那套）
 *
 * 最外层容器是纯 Tailwind（设置页外壳已迁 BoardUI），不再借旧的 panel 类过渡。
 * 免得分区卡片外面再套一层卡片边框。
 */

import { PROJECT_STATUS_LABEL, ITERATION_STATUS_LABEL } from '../labels.js'
import { fromDateInput } from '../roster.js'
import { fmtTime } from '../format.js'
import { client } from '../context.js'
import { Button } from '../../boardui/index'
import { EmptyState } from '../../boardui/empty-state'

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
const ROW_END = 'flex min-w-0 flex-wrap items-center justify-end gap-2'
const GRID2 = 'grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2'
const LISTROW = 'flex min-w-0 items-start justify-between gap-3 border-b border-separator-border py-3 last:border-b-0 last:pb-0'
const LISTROW_MAIN = 'flex min-w-0 flex-1 flex-col gap-1'
const LISTROW_TITLE = 'flex flex-wrap items-center gap-2 text-body-2-medium text-text-primary'
const LISTROW_ACTIONS = 'flex shrink-0 flex-wrap items-center gap-2'
const DIVIDER = 'flex min-w-0 flex-col gap-2 border-t border-separator-border pt-3'

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

export function LdapPanel({ config, onChanged }) {
  const { h, api, toast, TextField, CheckField, SwitchToggle , React } = client()
  const ldap = config.ldap ?? {}
  const [draft, setDraft] = React.useState({
    enabled: ldap.enabled === true,
    url: ldap.url ?? 'ldap://localhost:389',
    baseDN: ldap.baseDN ?? 'DC=LYF,DC=COM',
    bindDN: ldap.bindDN ?? 'cn=root',
    bindPassword: '',
    userFilter: ldap.userFilter ?? '(|(sAMAccountName={user})(uid={user})(mail={user}))',
    nameAttr: ldap.nameAttr ?? 'displayName',
    mailAttr: ldap.mailAttr ?? 'mail',
    deptAttr: ldap.deptAttr ?? 'department',
    defaultRole: ldap.defaultRole ?? 'member',
    requireLogin: ldap.requireLogin === true,
    timeoutMs: String(ldap.timeoutMs ?? 6000),
  })
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [note, setNote] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [steps, setSteps] = React.useState([])
  const localAuth = config.localAuth ?? {}
  const [oldPw, setOldPw] = React.useState('')
  const [newPw, setNewPw] = React.useState('')
  const [pwBusy, setPwBusy] = React.useState(false)
  const [pwNote, setPwNote] = React.useState(null)
  const [pwError, setPwError] = React.useState(null)
  const changePassword = async () => {
    setPwBusy(true); setPwNote(null); setPwError(null)
    try {
      await api('/auth/password', { username: localAuth.username, currentPassword: oldPw, newPassword: newPw })
      setOldPw(''); setNewPw('')
      setPwNote('密码已更新；所有旧会话已失效，开着登录的话请重新登录')
      onChanged()
    } catch (cause) {
      setPwError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPwBusy(false)
    }
  }
  const patch = next => setDraft(current => ({ ...current, ...next }))

  const test = async () => {
    setTesting(true); setNote(null); setError(null); setSteps([])
    try {
      const payload = await api('/auth/ldap/test', {
        ldap: {
          url: draft.url, baseDN: draft.baseDN, bindDN: draft.bindDN, userFilter: draft.userFilter,
          nameAttr: draft.nameAttr, mailAttr: draft.mailAttr, deptAttr: draft.deptAttr,
          timeoutMs: Number(draft.timeoutMs),
        },
        bindPassword: draft.bindPassword,
      })
      setSteps(payload.steps ?? [])
      setNote(payload.message ?? '连接正常'); toast(payload.message ?? '连接正常', payload.ok === false ? 'error' : 'success')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setBusy(true); setNote(null); setError(null)
    try {
      const body = {
        ldap: {
          enabled: draft.enabled,
          url: draft.url.trim(),
          baseDN: draft.baseDN.trim(),
          bindDN: draft.bindDN.trim(),
          userFilter: draft.userFilter.trim(),
          nameAttr: draft.nameAttr.trim(),
          mailAttr: draft.mailAttr.trim(),
          deptAttr: draft.deptAttr.trim(),
          defaultRole: draft.defaultRole,
          requireLogin: draft.requireLogin,
          timeoutMs: Number(draft.timeoutMs) || 6000,
        },
      }
      if (draft.bindPassword.trim() !== '') body.ldap.bindPassword = draft.bindPassword.trim()
      await api('/config', body)
      patch({ bindPassword: '' })
      setNote(draft.bindPassword.trim() === '' ? '已保存（服务账号密码没改）' : '已保存，服务账号密码已写入密钥文件')
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return h('div', { className: PANE, 'data-panel': 'platform-ldap' },
    h('div', { className: SECTION, 'data-section': 'ldap' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '统一登录（LDAP）'),
          h('div', { className: DESC }, ldap.bindPasswordSet === true ? '服务账号密码已保存' : '服务账号密码还没保存'),
        ),
      ),
      h('div', { className: HINT },
        '开启后，页头会出现登录框：用域账号登录，平台拿到的用户名会记进 config.users（首次登录建档、之后只更新最近登录），写操作和审计都挂在这个名字下。'),
      h(SwitchToggle, {
        checked: draft.enabled,
        label: '启用 LDAP 登录',
        onChange: event => patch({ enabled: event.target.checked }),
      }),
      h(CheckField, {
        checked: draft.requireLogin,
        onChange: event => patch({ requireLogin: event.target.checked }),
      }, '必须登录才能用（不勾也可以先配好再打开）'),
      h('div', { className: 'flex min-w-0 flex-wrap items-start gap-2' },
        h('div', { className: FIELD, style: { flex: 2 } },
          h('div', { className: LABEL }, '服务器地址'),
          h(TextField, { value: draft.url, placeholder: 'ldap://host:389', onChange: event => patch({ url: event.target.value }) }),
        ),
        h('div', { className: FIELD, style: { flex: '0 0 110px' } },
          h('div', { className: LABEL }, '超时（毫秒）'),
          h(TextField, { value: draft.timeoutMs, onChange: event => patch({ timeoutMs: event.target.value }) }),
        ),
      ),
      h('div', { className: 'flex min-w-0 flex-wrap items-start gap-2' },
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, 'BASE DN'),
          h(TextField, { value: draft.baseDN, placeholder: 'DC=LYF,DC=COM', onChange: event => patch({ baseDN: event.target.value }) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '服务账号 DN'),
          h(TextField, { value: draft.bindDN, placeholder: 'cn=root', onChange: event => patch({ bindDN: event.target.value }) }),
        ),
      ),
      h('div', { className: 'flex min-w-0 flex-wrap items-start gap-2' },
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, ldap.bindPasswordSet === true ? '服务账号密码（留空 = 不改）' : '服务账号密码'),
          h(TextField, {
            type: 'password', value: draft.bindPassword,
            placeholder: ldap.bindPasswordSet === true ? '已保存，留空表示不修改' : '写一次就进密钥文件',
            onChange: event => patch({ bindPassword: event.target.value }),
          }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '用户过滤器（{user} 会被替换）'),
          h(TextField, { value: draft.userFilter, onChange: event => patch({ userFilter: event.target.value }) }),
        ),
      ),
      h('div', { className: 'flex min-w-0 flex-wrap items-start gap-2' },
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '显示名属性'),
          h(TextField, { value: draft.nameAttr, onChange: event => patch({ nameAttr: event.target.value }) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '邮箱属性'),
          h(TextField, { value: draft.mailAttr, onChange: event => patch({ mailAttr: event.target.value }) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '部门属性'),
          h(TextField, { value: draft.deptAttr, onChange: event => patch({ deptAttr: event.target.value }) }),
        ),
      ),
      h('div', { className: ROW },
        h(Button, { variant: 'secondary', size: 'sm', disabled: testing, onClick: () => void test() }, testing ? '测试中…' : '测试连接'),
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
      ),
      steps.length === 0 ? null : h('div', { className: 'flex min-w-0 flex-col gap-1' },
        steps.map((step, index) => h('div', { key: `ldap-step-${index}`, className: step.ok === true ? OK : ERR, 'data-ok': step.ok === true ? '1' : '0' },
          `${step.ok === true ? '成功' : '失败'} · ${step.name}：${step.message}${step.ms > 0 ? `（${step.ms}ms）` : ''}`)),
      ),
      note === null ? null : h('div', { className: OK, role: 'status' }, note),
      error === null ? null : h('div', { className: ERR, role: 'alert' }, error),
      h('div', { className: HINT },
        '依赖系统里的 ldapsearch（Ubuntu：apt-get install ldap-utils）。密码只写进 ~/.dsh/dsh-studio.secrets.json（0600），不会出现在状态、导出和日志里。'),
    ),
    h('div', { className: SECTION, 'data-section': 'local-admin' },
      h('div', { className: SECTION_TITLE }, '本地超管账号'),
      h('div', { className: HINT },
        `账号：${localAuth.username ?? 'admin'} · ${localAuth.hasPassword === true ? '已设置自己的密码' : '还在用默认口令 admin'}。没启用 LDAP 时平台默认以这个身份使用，不需要登录；启用 LDAP 后它仍可用来兜底登录。`),
      h('div', { className: 'flex min-w-0 flex-wrap items-end gap-2' },
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '当前密码'),
          h(TextField, { type: 'password', value: oldPw, onChange: event => setOldPw(event.target.value) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '新密码（至少 8 位）'),
          h(TextField, { type: 'password', value: newPw, onChange: event => setNewPw(event.target.value) }),
        ),
        h(Button, {
          variant: 'secondary', size: 'sm',
          disabled: pwBusy || oldPw === '' || newPw.length < 8,
          onClick: () => void changePassword(),
        }, pwBusy ? '提交中…' : '改密码'),
      ),
      pwNote === null ? null : h('div', { className: OK, role: 'status' }, pwNote),
      pwError === null ? null : h('div', { className: ERR, role: 'alert' }, pwError),
    ),
    h('div', { className: SECTION, 'data-section': 'logged-in-users' },
      h('div', { className: SECTION_TITLE }, `登录过的人（${(config.users ?? []).length}）`),
      (config.users ?? []).length === 0
        ? h(EmptyState, { title: '还没有人用 LDAP 登录过。' })
        : h('div', { className: 'flex min-w-0 flex-col' }, (config.users ?? []).slice(0, 20).map(user => h('div', {
          key: user.id,
          className: 'flex min-w-0 flex-col gap-1 border-b border-separator-border py-2 last:border-b-0 last:pb-0 md:flex-row md:items-baseline md:gap-3',
          'data-user-row': '',
        },
          h('div', { className: 'shrink-0 text-body-2-medium text-text-primary' }, user.name),
          h('div', { className: HINT }, `${user.id} · ${user.dept === '' ? '（无部门）' : user.dept} · 登录 ${user.loginCount} 次 · 最近 ${fmtTime(user.lastLoginAt)}`),
        ))),
    ),
  )
}

export function CostsPanel({ config, onChanged, suggestModels }) {
  const { h, api, TextField , React } = client()
  const costs = config.costs ?? {}
  const [runs, setRuns] = React.useState(String(costs.budgetRuns ?? 500))
  const [hours, setHours] = React.useState(String(costs.budgetHours ?? 80))
  const [warnAt, setWarnAt] = React.useState(String(costs.warnAt ?? 80))
  const [prices, setPrices] = React.useState(() => (Array.isArray(costs.prices) ? costs.prices.map(item => ({ ...item })) : []))
  const [suggested, setSuggested] = React.useState(0)
  // 效能页的「补价目」把「算不出钱的模型」带过来：缺哪行补哪行，已有的不重复加。
  // 补进来的行单价是 0，必须人真填了再保存——0 元的价目会让报表看起来「很便宜」，比未知更糟。
  React.useEffect(() => {
    const wanted = (Array.isArray(suggestModels) ? suggestModels : [])
      .map(name => String(name ?? '').trim())
      .filter(name => name !== '')
    if (wanted.length === 0) return
    const have = new Set((Array.isArray(costs.prices) ? costs.prices : []).map(item => String(item.model ?? '').trim()))
    const missing = wanted.filter(name => !have.has(name))
    setSuggested(missing.length)
    if (missing.length === 0) return
    setPrices(list => {
      const current = new Set(list.map(item => String(item.model ?? '').trim()))
      const todo = missing.filter(name => !current.has(name))
      return todo.length === 0 ? list : [...list, ...todo.map(name => ({ model: name, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }))]
    })
  }, [suggestModels])
  const savePrices = async () => {
    setBusy(true); setNote(null); setError(null)
    try {
      const cleaned = prices
        .filter(item => String(item.model ?? '').trim() !== '')
        .map(item => ({
          model: String(item.model).trim(),
          input: Number(item.input) || 0,
          output: Number(item.output) || 0,
          cacheRead: Number(item.cacheRead) || 0,
          cacheWrite: Number(item.cacheWrite) || 0,
        }))
      await api('/config', {
        costs: {
          budgetRuns: Number(costs.budgetRuns ?? 500),
          budgetHours: Number(costs.budgetHours ?? 80),
          warnAt: Number(costs.warnAt ?? 80),
          prices: cleaned,
        },
      })
      setPrices(cleaned)
      setNote('已保存：价目表 ' + cleaned.length + ' 行')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState(null)
  const [error, setError] = React.useState(null)
  const save = async () => {
    setBusy(true); setNote(null); setError(null)
    try {
      const runValue = Number(runs)
      const hourValue = Number(hours)
      const warnValue = Number(warnAt)
      if (!Number.isFinite(runValue) || runValue <= 0) throw new Error('预算次数要是正整数')
      if (!Number.isFinite(hourValue) || hourValue <= 0) throw new Error('预算小时要是正整数')
      await api('/config', {
        costs: {
          budgetRuns: Math.round(runValue),
          budgetHours: Math.round(hourValue),
          warnAt: Number.isFinite(warnValue) ? Math.min(100, Math.max(10, Math.round(warnValue))) : 80,
          // 保存预算时必须把价目表带上，否则 sanitizeCosts 会把它当空数组清掉
          prices,
        },
      })
      setNote('已保存：预算')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  return h('div', { className: PANE, 'data-panel': 'platform-costs' },
    h('div', { className: SECTION, 'data-section': 'budget' },
      h('div', { className: SECTION_TITLE }, '成本预算'),
      h('div', { className: GRID2 },
        fieldOf(h, '每月派单次数上限',
          h(TextField, { value: runs, onChange: event => setRuns(event.target.value) })),
        fieldOf(h, '每月机上时长上限（小时）',
          h(TextField, { value: hours, onChange: event => setHours(event.target.value) })),
        fieldOf(h, '警告阈值（百分比）',
          h(TextField, { value: warnAt, onChange: event => setWarnAt(event.target.value) })),
      ),
      h('div', { className: HINT }, '效能页的「AI 执行成本」会显示真实 token 用量（读 studio-* 会话日志）。要显示钱就在 config.costs.prices 里配价目表：[{ "model": "deepseek-v4.1-flash", "input": 2, "output": 8, "cacheRead": 0.2 }]，单位是元 / 百万 token；没配价目的调用记「未知」，不按 0 算。'),
      h('div', { className: DIVIDER },
        h('div', { className: LABEL }, '价目表（元 / 百万 token）'),
        suggested > 0
          ? h('div', { className: 'flex min-w-0 flex-col gap-1 rounded-lg border border-separator-border bg-background-secondary-default p-2', 'data-suggested': String(suggested) },
            h('div', { className: HINT },
              `已从效能页带过来 ${suggested} 个还没配价目的模型：填好单价再点「保存价目表」。单价留 0 的话仍然算「未知」，不会当成免费。`))
          : null,
        prices.length === 0
          ? h(EmptyState, { title: '还是空的：只统计 token，不算钱。点「加一行」把常见模型的价格填进来。' })
          : h('div', { className: 'flex min-w-0 flex-col gap-2' },
            prices.map((item, index) => h('div', { key: index, className: 'flex min-w-0 flex-wrap items-center gap-2', 'data-price-row': '' },
              h(TextField, { style: { flex: '2 1 180px' }, placeholder: '模型 id，如 deepseek-v4.1-flash', 'aria-label': `第 ${index + 1} 行模型 id`, value: item.model ?? '', onChange: event => setPrices(list => list.map((row, i) => (i === index ? { ...row, model: event.target.value } : row))) }),
              h(TextField, { style: { flex: '1 1 70px' }, placeholder: '输入', 'aria-label': `第 ${index + 1} 行输入单价`, value: String(item.input ?? ''), onChange: event => setPrices(list => list.map((row, i) => (i === index ? { ...row, input: Number(event.target.value) || 0 } : row))) }),
              h(TextField, { style: { flex: '1 1 70px' }, placeholder: '输出', 'aria-label': `第 ${index + 1} 行输出单价`, value: String(item.output ?? ''), onChange: event => setPrices(list => list.map((row, i) => (i === index ? { ...row, output: Number(event.target.value) || 0 } : row))) }),
              h(TextField, { style: { flex: '1 1 70px' }, placeholder: '缓存读', 'aria-label': `第 ${index + 1} 行缓存读单价`, value: String(item.cacheRead ?? ''), onChange: event => setPrices(list => list.map((row, i) => (i === index ? { ...row, cacheRead: Number(event.target.value) || 0 } : row))) }),
              h(Button, { variant: 'ghost', size: 'sm', 'aria-label': `删除第 ${index + 1} 行价目`, onClick: () => setPrices(list => list.filter((_, i) => i !== index)) }, '删除'),
            )),
          ),
        h('div', { className: ROW_END },
          h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setPrices(list => [...list, { model: '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]) }, '加一行'),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void savePrices() }, busy ? '保存中…' : '保存价目表'),
        ),
      ),
      h('div', { className: ROW_END },
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存预算'),
      ),
      note === null ? null : h('div', { className: OK, role: 'status' }, note),
      error === null ? null : h('div', { className: ERR, role: 'alert' }, error),
    ),
  )
}

export function BusinessPanel({ config, onChanged }) {
  const { h, api, toast, confirmDialog, tipOf, TextField, SelectField, DateField, ChipField , React } = client()
  const projects = config.projects ?? []
  const repos = config.gitlab?.projects ?? []
  const [draft, setDraft] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [note, setNote] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [iter, setIter] = React.useState({ name: '', start: '', due: '', status: 'planned' })

  const save = async () => {
    if (draft === null) return
    setBusy(true); setError(null); setNote(null)
    try {
      await api('/projects/save', { project: { ...draft, iterations: draft.iterations ?? [] } })
      setNote('已保存'); toast('已保存'); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const remove = async project => {
    if (!(await confirmDialog(`删除项目「${project.name}」？卡片会保留，但不再归属任何项目。`, { title: '删除项目', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null)
    try { await api('/projects/delete', { id: project.id }); setDraft(null); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const addIteration = async project => {
    if (iter.name.trim() === '') return
    setBusy(true); setError(null)
    try {
      await api('/projects/iteration', {
        project: project.id, name: iter.name.trim(),
        start: fromDateInput(iter.start), due: fromDateInput(iter.due), status: iter.status,
      })
      setIter({ name: '', start: '', due: '', status: 'planned' })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const removeIteration = async (project, iteration) => {
    setBusy(true); setError(null)
    try { await api('/projects/iteration', { project: project.id, action: 'remove', iteration: iteration.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const set = (key, value) => setDraft({ ...draft, [key]: value })
  const setService = (index, key, value) => setDraft({
    ...draft,
    services: (draft.services ?? []).map((item, at) => (at === index ? { ...item, [key]: value } : item)),
  })
  const addService = () => setDraft({
    ...draft,
    services: [...(draft.services ?? []), { id: '', name: '', repoId: '', repoPath: '', baseBranch: draft.baseBranch || 'main', dependsOn: [] }],
  })
  const dropService = index => setDraft({ ...draft, services: (draft.services ?? []).filter((item, at) => at !== index) })
  const services = draft === null ? [] : (draft.services ?? [])
  // 服务依赖：只能选本项目里已经有 id 的其它服务（新建的服务要先保存一次才能被依赖）。
  const toggleDep = (index, depId) => setDraft({
    ...draft,
    services: (draft.services ?? []).map((item, at) => {
      if (at !== index) return item
      const current = Array.isArray(item.dependsOn) ? item.dependsOn : []
      return { ...item, dependsOn: current.includes(depId) ? current.filter(one => one !== depId) : [...current, depId] }
    }),
  })

  const rows = projects.map(project => h('div', { className: LISTROW, key: project.id, 'data-project-row': '' },
    h('div', { className: LISTROW_MAIN },
      h('div', { className: LISTROW_TITLE }, `${project.key ? `[${project.key}] ` : ''}${project.name}`),
      h('div', { className: HINT }, `状态 ${PROJECT_STATUS_LABEL[project.status] ?? project.status}${project.lead ? ` · 负责人 ${project.lead}` : ''} · ${(config.projects ?? []).find(x => x.id === project.id)?.iterations?.length ?? 0} 个迭代 · ${(project.services ?? []).length} 个服务${(() => { const edges = (project.services ?? []).reduce((sum, one) => sum + (one.dependsOn ?? []).length, 0); return edges > 0 ? ` · ${edges} 条依赖` : '' })()}${project.description ? ` · ${project.description}` : ''}`),
    ),
    h('div', { className: LISTROW_ACTIONS },
      tipOf('改项目信息、加迭代', h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft({ ...project }) }, '编辑 / 迭代')),
      tipOf('删除这个项目（卡不会删）', h(Button, { variant: 'danger', size: 'sm', disabled: busy, onClick: () => void remove(project), 'data-danger': '1' }, '删除')),
    ),
  ))

  return h('div', { className: PANE, 'data-panel': 'platform-business' },
    listSection({
      h, hook: 'projects',
      title: '业务项目（一个项目可以挂很多张卡和很多个迭代）',
      hint: '项目是看板的第一层分组：卡片挂项目，项目下面划迭代，看板可按项目和迭代筛选，项目页签看每个项目的体检数据。',
      rows, addLabel: '新增项目',
      onAdd: () => setDraft({ id: '', name: '', key: '', description: '', lead: '', status: 'active', repos: [], services: [], iterations: [] }),
      empty: '还没有项目。团队只跑一个产品也可以先不建，直接在看板上干活。',
    }),
    note !== null ? h('div', { className: OK, role: 'status' }, note) : null,
    error !== null && draft === null ? h('div', { className: ERR, role: 'alert' }, error) : null,
    draft === null ? null : h('div', { className: SECTION, 'data-section': 'project-form' },
      h('div', { className: SECTION_TITLE }, draft.id ? `编辑项目：${draft.name || draft.id}` : '新增项目'),
      h('div', { className: 'flex min-w-0 flex-wrap items-start gap-3' },
        h('div', { className: FIELD, style: { flex: '0 0 110px' } },
          h('div', { className: LABEL }, '代号'),
          h(TextField, { value: draft.key ?? '', placeholder: 'ORD', onChange: e => set('key', e.target.value) }),
        ),
        h('div', { className: FIELD, style: { flex: 2 } },
          h('div', { className: LABEL }, '项目名'),
          h(TextField, { value: draft.name ?? '', placeholder: '订单中心', onChange: e => set('name', e.target.value) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '状态'),
          h(SelectField, {
            size: 'md',
            value: draft.status ?? 'active',
            'aria-label': '项目状态',
            onChange: e => set('status', e.target.value),
          },
            Object.keys(PROJECT_STATUS_LABEL).map(value => h('option', { key: value, value }, PROJECT_STATUS_LABEL[value]))),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '业务负责人'),
          h(TextField, { value: draft.lead ?? '', placeholder: '张伟', onChange: e => set('lead', e.target.value) }),
        ),
      ),
      h('div', { className: 'flex min-w-0 flex-wrap items-start gap-3' },
        h('div', { className: FIELD, style: { flex: 3 } },
          h('div', { className: LABEL }, '默认代码目录（没有分服务时用）'),
          h(TextField, {
            value: draft.repoPath ?? '',
            placeholder: '~/repos/order-center',
            onChange: e => set('repoPath', e.target.value),
          }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '基线分支'),
          h(TextField, {
            value: draft.baseBranch ?? '',
            placeholder: 'main',
            onChange: e => set('baseBranch', e.target.value),
          }),
        ),
      ),
      fieldOf(h, '项目检查命令（服务没配时用它）',
        h(TextField, {
          value: draft.qualityCmd ?? '', placeholder: 'npm run check',
          onChange: e => set('qualityCmd', e.target.value),
        })),
      h('div', { className: HINT }, '配了以后，改过代码的卡在收口前必须跑过这条命令（卡片「执行记录」里有「跑一次」）。默认超时 120 秒。'),
      h('div', { className: HINT }, '配了代码目录且「代码隔离」选 worktree 时，每张卡会切一条 task/<编号> 分支，互不干扰。项目里有多个服务时，用下面的服务列表分开配。'),
      h('div', { className: FIELD },
        h('div', { className: LABEL }, `服务（${services.length}）· 一个服务一个 git 路径，卡片可以指定改哪个`),
        services.length === 0
          ? h(EmptyState, { title: '还没有分服务。只有一个仓库时留空即可，走上面的默认代码目录。' })
          : h('div', { className: 'flex min-w-0 flex-col gap-3' },
            services.map((service, index) => {
              const others = services.filter((one, at) => at !== index && String(one.id ?? '').trim() !== '')
              return h('div', { key: `${service.id}-${index}`, className: 'flex min-w-0 flex-col gap-2 rounded-lg border border-separator-border p-3', 'data-service-row': '' },
                h('div', { className: 'flex min-w-0 flex-wrap items-end gap-2' },
                  h('div', { className: FIELD, style: { flex: '0 0 150px' } },
                    h('div', { className: LABEL }, '服务名'),
                    h(TextField, {
                      value: service.name ?? '', placeholder: 'order-service',
                      onChange: e => setService(index, 'name', e.target.value),
                    }),
                  ),
                  h('div', { className: FIELD, style: { flex: 3 } },
                    h('div', { className: LABEL }, '本机 git 路径'),
                    h(TextField, {
                      value: service.repoPath ?? '', placeholder: '~/repos/order-service',
                      onChange: e => setService(index, 'repoPath', e.target.value),
                    }),
                  ),
                  h('div', { className: FIELD, style: { flex: '0 0 110px' } },
                    h('div', { className: LABEL }, '基线分支'),
                    h(TextField, {
                      value: service.baseBranch ?? '', placeholder: 'main',
                      onChange: e => setService(index, 'baseBranch', e.target.value),
                    }),
                  ),
                  repos.length === 0
                    ? null
                    : h('div', { className: FIELD, style: { flex: '0 0 150px' } },
                      h('div', { className: LABEL }, 'GitLab 仓库'),
                      h(SelectField, {
                        size: 'md',
                        value: service.repoId ?? '',
                        'aria-label': `第 ${index + 1} 个服务的 GitLab 仓库`,
                        onChange: e => setService(index, 'repoId', e.target.value),
                      },
                        h('option', { value: '' }, '不关联'),
                        repos.map(repo => h('option', { key: repo.id, value: repo.id }, repo.name || repo.project)),
                      ),
                    ),
                  h(Button, { variant: 'danger', size: 'sm', type: 'button', 'aria-label': `删除第 ${index + 1} 个服务`, onClick: () => dropService(index), 'data-danger': '1' }, '删除'),
                ),
                others.length === 0
                  ? null
                  : h('div', { className: ROW },
                    h('span', { className: HINT }, '检查命令'),
                    h(TextField, {
                      value: service.qualityCmd ?? '', placeholder: '留空用项目级',
                      'aria-label': `第 ${index + 1} 个服务的检查命令`,
                      style: { flex: '0 0 220px' },
                      onChange: e => setService(index, 'qualityCmd', e.target.value),
                    }),
                    h('span', { className: HINT }, '依赖（勾上的服务要先完成，本服务的卡才能收口）'),
                    others.map(other => h(ChipField, {
                      key: other.id,
                      variant: 'gray',
                      'data-on': (service.dependsOn ?? []).includes(other.id) ? '1' : '0',
                      title: `依赖 ${other.name || other.id}`,
                      style: { cursor: 'pointer' },
                      onClick: () => toggleDep(index, other.id),
                    }, other.name || other.id)),
                  ),
              )
            }),
          ),
        h('div', { className: ROW },
          h(Button, { variant: 'secondary', size: 'sm', type: 'button', onClick: () => addService() }, '加一个服务'),
          h('span', { className: HINT }, '服务名会被写进任务详情；worktree 从该服务的 git 路径切 task/<编号> 分支。'),
        ),
      ),
      fieldOf(h, '项目说明',
        h(TextField, { value: draft.description ?? '', placeholder: '这个项目做什么、给谁用', onChange: e => set('description', e.target.value) })),
      h('div', { className: ROW },
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存项目'),
        h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => setDraft(null) }, '取消'),
      ),
      error !== null ? h('div', { className: ERR, role: 'alert' }, error) : null,
    ),
    draft === null || draft.id === '' ? null : h('div', { className: SECTION, 'data-section': 'project-iterations' },
      h('div', { className: SECTION_HEAD },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: SECTION_TITLE }, '迭代'),
          h('div', { className: DESC }, '迭代用来按时间切需求，看板可按迭代筛选'),
        ),
      ),
      (draft.iterations ?? []).length === 0
        ? h(EmptyState, { title: '还没有迭代。可以先加一个「2026-11 迭代」。' })
        : h('div', { className: 'flex min-w-0 flex-col' },
          (draft.iterations ?? []).map(iteration => h('div', { className: LISTROW, key: iteration.id, 'data-iteration-row': '' },
            h('div', { className: LISTROW_MAIN },
              h('div', { className: LISTROW_TITLE }, `${iteration.name} · ${ITERATION_STATUS_LABEL[iteration.status] ?? iteration.status}`),
              h('div', { className: HINT }, `${iteration.start ? new Date(iteration.start).toISOString().slice(0, 10) : '未定开始'} → ${iteration.due ? new Date(iteration.due).toISOString().slice(0, 10) : '未定结束'}`),
            ),
            h('div', { className: LISTROW_ACTIONS },
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy, 'aria-label': `删除迭代 ${iteration.name}`, onClick: () => void removeIteration(draft, iteration) }, '删除'),
            ),
          ))),
      h('div', { className: 'flex min-w-0 flex-wrap items-end gap-2' },
        h('div', { className: FIELD, style: { flex: 2 } },
          h('div', { className: LABEL }, '迭代名'),
          h(TextField, { value: iter.name, placeholder: '2026-11 迭代', onChange: e => setIter({ ...iter, name: e.target.value }) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '开始'),
          h(DateField, { value: iter.start, onChange: e => setIter({ ...iter, start: e.target.value }) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '结束'),
          h(DateField, { value: iter.due, onChange: e => setIter({ ...iter, due: e.target.value }) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, '状态'),
          h(SelectField, {
            size: 'md',
            value: iter.status,
            'aria-label': '迭代状态',
            onChange: e => setIter({ ...iter, status: e.target.value }),
          },
            Object.keys(ITERATION_STATUS_LABEL).map(value => h('option', { key: value, value }, ITERATION_STATUS_LABEL[value]))),
        ),
        h(Button, { variant: 'secondary', size: 'sm', disabled: busy || iter.name.trim() === '', onClick: () => void addIteration(draft) }, '加迭代'),
      ),
      h('div', { className: HINT }, '迭代改完会立刻反映到看板的迭代筛选。'),
    ),
  )
}
