/* Settings panels lifted out of client.src.js; shared handles come from the studio context. */

import { PROJECT_STATUS_LABEL, ITERATION_STATUS_LABEL } from '../labels.js'
import { fromDateInput } from '../roster.js'
import { fmtTime } from '../format.js'
import { client } from '../context.js'

export function LdapPanel({ config, onChanged }) {
  const { h, Editor, api, toast, confirmDialog, tipOf, TextField, CheckField, SelectField , React } = client()
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
      setPwNote('密码已更新')
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

  return h('div', { className: 'ds-panel ds-form-panel' },
    h('div', { className: 'ds-panel-head' }, '统一登录（LDAP）',
      h('span', { className: 'ds-hint' }, ldap.bindPasswordSet === true ? '服务账号密码已保存' : '服务账号密码还没保存')),
    h('div', { className: 'ds-panel-body' },
      h('div', { className: 'ds-hint' },
        '开启后，页头会出现登录框：用域账号登录，平台拿到的用户名会记进 config.users（首次登录建档、之后只更新最近登录），写操作和审计都挂在这个名字下。'),
      h('label', { className: 'ds-check', style: { marginTop: 8 } },
        h(CheckField, { checked: draft.enabled, onChange: event => patch({ enabled: event.target.checked }) }),
        h('span', { className: 'ds-check-text' }, '启用 LDAP 登录'),
      ),
      h('label', { className: 'ds-check', style: { marginTop: 6 } },
        h(CheckField, { checked: draft.requireLogin, onChange: event => patch({ requireLogin: event.target.checked }) }),
        h('span', { className: 'ds-check-text' }, '必须登录才能用（不勾也可以先配好再打开）'),
      ),
      h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8 } },
        h('div', { className: 'ds-field', style: { flex: 2 } },
          h('div', { className: 'ds-label' }, '服务器地址'),
          h(TextField, { className: 'ds-input', value: draft.url, placeholder: 'ldap://host:389', onChange: event => patch({ url: event.target.value }) }),
        ),
        h('div', { className: 'ds-field', style: { flex: '0 0 110px' } },
          h('div', { className: 'ds-label' }, '超时（毫秒）'),
          h(TextField, { className: 'ds-input', value: draft.timeoutMs, onChange: event => patch({ timeoutMs: event.target.value }) }),
        ),
      ),
      h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8 } },
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, 'BASE DN'),
          h(TextField, { className: 'ds-input', value: draft.baseDN, placeholder: 'DC=LYF,DC=COM', onChange: event => patch({ baseDN: event.target.value }) }),
        ),
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, '服务账号 DN'),
          h(TextField, { className: 'ds-input', value: draft.bindDN, placeholder: 'cn=root', onChange: event => patch({ bindDN: event.target.value }) }),
        ),
      ),
      h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8 } },
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, ldap.bindPasswordSet === true ? '服务账号密码（留空 = 不改）' : '服务账号密码'),
          h(TextField, {
            className: 'ds-input', type: 'password', value: draft.bindPassword,
            placeholder: ldap.bindPasswordSet === true ? '已保存，留空表示不修改' : '写一次就进密钥文件',
            onChange: event => patch({ bindPassword: event.target.value }),
          }),
        ),
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, '用户过滤器（{user} 会被替换）'),
          h(TextField, { className: 'ds-input', value: draft.userFilter, onChange: event => patch({ userFilter: event.target.value }) }),
        ),
      ),
      h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8 } },
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, '显示名属性'),
          h(TextField, { className: 'ds-input', value: draft.nameAttr, onChange: event => patch({ nameAttr: event.target.value }) }),
        ),
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, '邮箱属性'),
          h(TextField, { className: 'ds-input', value: draft.mailAttr, onChange: event => patch({ mailAttr: event.target.value }) }),
        ),
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, '部门属性'),
          h(TextField, { className: 'ds-input', value: draft.deptAttr, onChange: event => patch({ deptAttr: event.target.value }) }),
        ),
      ),
      h('div', { className: 'ds-row', style: { gap: 8, marginTop: 10 } },
        h('button', { className: 'ds-btn', disabled: testing, onClick: () => void test() }, testing ? '测试中…' : '测试连接'),
        h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
      ),
      steps.length === 0 ? null : h('div', { style: { marginTop: 8 } },
        steps.map((step, index) => h('div', { key: `ldap-step-${index}`, className: step.ok === true ? 'ds-ok' : 'ds-error' },
          `${step.ok === true ? '✓' : '✗'} ${step.name}：${step.message}${step.ms > 0 ? `（${step.ms}ms）` : ''}`)),
      ),
      note === null ? null : h('div', { className: 'ds-ok', style: { marginTop: 8 } }, note),
      error === null ? null : h('div', { className: 'ds-error', style: { marginTop: 8 } }, error),
      h('div', { className: 'ds-hint', style: { marginTop: 10 } },
        '依赖系统里的 ldapsearch（Ubuntu：apt-get install ldap-utils）。密码只写进 ~/.dsh/dsh-studio.secrets.json（0600），不会出现在状态、导出和日志里。'),
    ),
    h('div', { className: 'ds-panel-body', style: { borderTop: '1px solid var(--ds-line)' } },
      h('div', { className: 'ds-label' }, '本地超管账号'),
      h('div', { className: 'ds-hint', style: { marginTop: 4 } },
        `账号：${localAuth.username ?? 'admin'} · ${localAuth.hasPassword === true ? '已设置自己的密码' : '还在用默认口令 admin'}。没启用 LDAP 时平台默认以这个身份使用，不需要登录；启用 LDAP 后它仍可用来兜底登录。`),
      h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8 } },
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, '当前密码'),
          h(TextField, { className: 'ds-input', type: 'password', value: oldPw, onChange: event => setOldPw(event.target.value) }),
        ),
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, '新密码（至少 8 位）'),
          h(TextField, { className: 'ds-input', type: 'password', value: newPw, onChange: event => setNewPw(event.target.value) }),
        ),
        h('button', {
          className: 'ds-btn',
          disabled: pwBusy || oldPw === '' || newPw.length < 8,
          onClick: () => void changePassword(),
        }, pwBusy ? '提交中…' : '改密码'),
      ),
      pwNote === null ? null : h('div', { className: 'ds-ok', style: { marginTop: 6 } }, pwNote),
      pwError === null ? null : h('div', { className: 'ds-error', style: { marginTop: 6 } }, pwError),
    ),
    h('div', { className: 'ds-panel-body', style: { borderTop: '1px solid var(--ds-line)' } },
      h('div', { className: 'ds-label' }, `登录过的人（${(config.users ?? []).length}）`),
      (config.users ?? []).length === 0
        ? h('div', { className: 'ds-hint', style: { marginTop: 6 } }, '还没有人用 LDAP 登录过。')
        : h('div', { style: { marginTop: 6 } }, (config.users ?? []).slice(0, 20).map(user => h('div', { key: user.id, className: 'ds-kv' },
          h('div', null, user.name),
          h('div', null, `${user.id} · ${user.dept === '' ? '（无部门）' : user.dept} · 登录 ${user.loginCount} 次 · 最近 ${fmtTime(user.lastLoginAt)}`),
        ))),
    ),
  )
}


export function CostsPanel({ config, onChanged }) {
  const { h, Editor, api, toast, confirmDialog, tipOf, TextField, CheckField, SelectField , React } = client()
  const costs = config.costs ?? {}
  const [runs, setRuns] = React.useState(String(costs.budgetRuns ?? 500))
  const [hours, setHours] = React.useState(String(costs.budgetHours ?? 80))
  const [warnAt, setWarnAt] = React.useState(String(costs.warnAt ?? 80))
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
        },
      })
      setNote('已保存：预算')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  return h('div', { className: 'ds-panel ds-form-panel' },
    h('div', { className: 'ds-panel-head' }, '成本预算'),
    h('div', { className: 'ds-panel-body ds-grid2' },
      h('div', { className: 'ds-field' },
        h('div', { className: 'ds-label' }, '每月派单次数上限'),
        h(TextField, { className: 'ds-input', value: runs, onChange: event => setRuns(event.target.value) }),
      ),
      h('div', { className: 'ds-field' },
        h('div', { className: 'ds-label' }, '每月机上时长上限（小时）'),
        h(TextField, { className: 'ds-input', value: hours, onChange: event => setHours(event.target.value) }),
      ),
      h('div', { className: 'ds-field' },
        h('div', { className: 'ds-label' }, '警告阈值（百分比）'),
        h(TextField, { className: 'ds-input', value: warnAt, onChange: event => setWarnAt(event.target.value) }),
      ),
      h('div', { className: 'ds-field ds-span' },
        h('div', { className: 'ds-hint' }, '效能页的「AI 执行成本」下方会出现预算条；口径是派单次数与机上时长，宿主没有回传 token 用量。'),
      ),
      h('div', { className: 'ds-row', style: { justifyContent: 'flex-end' } },
        h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存预算'),
      ),
      note === null ? null : h('div', { className: 'ds-ok' }, note),
      error === null ? null : h('div', { className: 'ds-err' }, error),
    ),
  )
}

export function BusinessPanel({ config, onChanged }) {
  const { h, Editor, api, toast, confirmDialog, tipOf, TextField, CheckField, SelectField , React } = client()
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

  const rows = projects.map(project => h('div', { className: 'ds-listrow', key: project.id },
    h('div', { className: 'ds-listrow-main' },
      h('div', {}, `${project.key ? `[${project.key}] ` : ''}${project.name} · ${PROJECT_STATUS_LABEL[project.status] ?? project.status}${project.lead ? ` · 负责人 ${project.lead}` : ''}`),
      h('div', { className: 'ds-hint' }, `${(config.projects ?? []).find(x => x.id === project.id)?.iterations?.length ?? 0} 个迭代 · ${(project.services ?? []).length} 个服务${(() => { const edges = (project.services ?? []).reduce((sum, one) => sum + (one.dependsOn ?? []).length, 0); return edges > 0 ? ` · ${edges} 条依赖` : '' })()}${project.description ? ` · ${project.description}` : ''}`),
    ),
    h('div', { className: 'ds-listrow-actions' },
      tipOf('改项目信息、加迭代', h('button', { className: 'ds-btn', disabled: busy, onClick: () => setDraft({ ...project }) }, '编辑 / 迭代')),
      tipOf('删除这个项目（卡不会删）', h('button', { className: 'ds-btn', disabled: busy, onClick: () => void remove(project), 'data-danger': '1' }, '删除')),
    ),
  ))

  return h('div', { className: 'ds-pane-stack' },
    h(Editor, {
      title: '业务项目（一个项目可以挂很多张卡和很多个迭代）',
      hint: '项目是看板的第一层分组：卡片挂项目，项目下面划迭代，看板可按项目和迭代筛选，项目页签看每个项目的体检数据。',
      rows, onAdd: () => setDraft({ id: '', name: '', key: '', description: '', lead: '', status: 'active', repos: [], services: [], iterations: [] }), addLabel: '新增项目',
      render: row => row,
      empty: '还没有项目。团队只跑一个产品也可以先不建，直接在看板上干活。',
    }),
    note !== null ? h('div', { className: 'ds-ok', style: { marginBottom: 8 } }, note) : null,
    draft === null ? null : h('div', { className: 'ds-panel ds-form-panel' },
      h('div', { className: 'ds-panel-head' }, draft.id ? `编辑项目：${draft.name || draft.id}` : '新增项目'),
      h('div', { className: 'ds-panel-body' },
        h('div', { className: 'ds-row', style: { gap: 12 } },
          h('div', { className: 'ds-field', style: { flex: '0 0 110px' } },
            h('div', { className: 'ds-label' }, '代号'),
            h(TextField, { className: 'ds-input', value: draft.key ?? '', placeholder: 'ORD', onChange: e => set('key', e.target.value) }),
          ),
          h('div', { className: 'ds-field', style: { flex: 2 } },
            h('div', { className: 'ds-label' }, '项目名'),
            h(TextField, { className: 'ds-input', value: draft.name ?? '', placeholder: '订单中心', onChange: e => set('name', e.target.value) }),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '状态'),
            h(SelectField, { className: 'ds-select', value: draft.status ?? 'active', onChange: e => set('status', e.target.value) },
              Object.keys(PROJECT_STATUS_LABEL).map(value => h('option', { key: value, value }, PROJECT_STATUS_LABEL[value]))),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '业务负责人'),
            h(TextField, { className: 'ds-input', value: draft.lead ?? '', placeholder: '张伟', onChange: e => set('lead', e.target.value) }),
          ),
        ),
        h('div', { className: 'ds-row', style: { gap: 12 } },
          h('div', { className: 'ds-field', style: { flex: 3 } },
            h('div', { className: 'ds-label' }, '默认代码目录（没有分服务时用）'),
            h(TextField, {
              className: 'ds-input', value: draft.repoPath ?? '',
              placeholder: '/home/lyf/repos/order-center',
              onChange: e => set('repoPath', e.target.value),
            }),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '基线分支'),
            h(TextField, {
              className: 'ds-input', value: draft.baseBranch ?? '',
              placeholder: 'main',
              onChange: e => set('baseBranch', e.target.value),
            }),
          ),
        ),
        h('div', { className: 'ds-hint', style: { margin: '-6px 0 4px' } }, '配了代码目录且「代码隔离」选 worktree 时，每张卡会切一条 task/<编号> 分支，互不干扰。项目里有多个服务时，用下面的服务列表分开配。'),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, `服务（${services.length}）· 一个服务一个 git 路径，卡片可以指定改哪个`),
          services.length === 0
            ? h('div', { className: 'ds-empty' }, '还没有分服务。只有一个仓库时留空即可，走上面的默认代码目录。')
            : services.map((service, index) => {
              const others = services.filter((one, at) => at !== index && String(one.id ?? '').trim() !== '')
              return h('div', { key: `${service.id}-${index}`, style: { marginBottom: 8 } },
                h('div', { className: 'ds-row', style: { gap: 8, alignItems: 'flex-end' } },
                  h('div', { className: 'ds-field', style: { flex: '0 0 150px' } },
                    h('div', { className: 'ds-label' }, '服务名'),
                    h(TextField, {
                      className: 'ds-input', value: service.name ?? '', placeholder: 'order-service',
                      onChange: e => setService(index, 'name', e.target.value),
                    }),
                  ),
                  h('div', { className: 'ds-field', style: { flex: 3 } },
                    h('div', { className: 'ds-label' }, '本机 git 路径'),
                    h(TextField, {
                      className: 'ds-input', value: service.repoPath ?? '', placeholder: '/home/lyf/repos/order-service',
                      onChange: e => setService(index, 'repoPath', e.target.value),
                    }),
                  ),
                  h('div', { className: 'ds-field', style: { flex: '0 0 110px' } },
                    h('div', { className: 'ds-label' }, '基线分支'),
                    h(TextField, {
                      className: 'ds-input', value: service.baseBranch ?? '', placeholder: 'main',
                      onChange: e => setService(index, 'baseBranch', e.target.value),
                    }),
                  ),
                  repos.length === 0
                    ? null
                    : h('div', { className: 'ds-field', style: { flex: '0 0 150px' } },
                      h('div', { className: 'ds-label' }, 'GitLab 仓库'),
                      h(SelectField, {
                        className: 'ds-select', value: service.repoId ?? '',
                        onChange: e => setService(index, 'repoId', e.target.value),
                      },
                        h('option', { value: '' }, '不关联'),
                        repos.map(repo => h('option', { key: repo.id, value: repo.id }, repo.name || repo.project)),
                      ),
                    ),
                  h('button', { className: 'ds-btn', type: 'button', onClick: () => dropService(index), 'data-danger': '1' }, '删除'),
                ),
                others.length === 0
                  ? null
                  : h('div', { className: 'ds-row', style: { gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
                    h('span', { className: 'ds-hint' }, '依赖'),
                    h('span', { className: 'ds-hint', style: { marginRight: 2 } }, '（勾上的服务要先完成，本服务的卡才能收口）'),
                    others.map(other => h('span', {
                      key: other.id,
                      className: 'ds-chip',
                      'data-on': (service.dependsOn ?? []).includes(other.id) ? '1' : '0',
                      title: `依赖 ${other.name || other.id}`,
                      onClick: () => toggleDep(index, other.id),
                    }, other.name || other.id)),
                  ),
              )
            }),
          h('div', { className: 'ds-row', style: { gap: 8 } },
            h('button', { className: 'ds-btn', type: 'button', onClick: () => addService() }, '＋ 加一个服务'),
            h('span', { className: 'ds-hint' }, '服务名会被写进任务详情；worktree 从该服务的 git 路径切 task/<编号> 分支。'),
          ),
        ),
        h('div', { className: 'ds-field' },
          h('div', { className: 'ds-label' }, '项目说明'),
          h(TextField, { className: 'ds-input', value: draft.description ?? '', placeholder: '这个项目做什么、给谁用', onChange: e => set('description', e.target.value) }),
        ),
        h('div', { className: 'ds-row', style: { gap: 8 } },
          h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存项目'),
          h('button', { className: 'ds-btn', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        ),
      ),
    ),
    draft === null || draft.id === '' ? null : h('div', { className: 'ds-panel ds-form-panel' },
      h('div', { className: 'ds-panel-head' }, '迭代', h('span', { className: 'ds-hint' }, '迭代用来按时间切需求，看板可按迭代筛选')),
      h('div', { className: 'ds-panel-body' },
        (draft.iterations ?? []).length === 0
          ? h('div', { className: 'ds-empty' }, '还没有迭代。可以先加一个「2026-11 迭代」。')
          : (draft.iterations ?? []).map(iteration => h('div', { className: 'ds-listrow', key: iteration.id },
            h('div', { className: 'ds-listrow-main' },
              h('div', {}, `${iteration.name} · ${ITERATION_STATUS_LABEL[iteration.status] ?? iteration.status}`),
              h('div', { className: 'ds-hint' }, `${iteration.start ? new Date(iteration.start).toISOString().slice(0, 10) : '未定开始'} → ${iteration.due ? new Date(iteration.due).toISOString().slice(0, 10) : '未定结束'}`),
            ),
            h('div', { className: 'ds-listrow-actions' },
              h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void removeIteration(draft, iteration) }, '×'),
            ),
          )),
        h('div', { className: 'ds-row', style: { gap: 8, alignItems: 'flex-end' } },
          h('div', { className: 'ds-field', style: { flex: 2 } },
            h('div', { className: 'ds-label' }, '迭代名'),
            h(TextField, { className: 'ds-input', value: iter.name, placeholder: '2026-11 迭代', onChange: e => setIter({ ...iter, name: e.target.value }) }),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '开始'),
            h(TextField, { className: 'ds-input', type: 'date', value: iter.start, onChange: e => setIter({ ...iter, start: e.target.value }) }),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '结束'),
            h(TextField, { className: 'ds-input', type: 'date', value: iter.due, onChange: e => setIter({ ...iter, due: e.target.value }) }),
          ),
          h('div', { className: 'ds-field', style: { flex: 1 } },
            h('div', { className: 'ds-label' }, '状态'),
            h(SelectField, { className: 'ds-select', value: iter.status, onChange: e => setIter({ ...iter, status: e.target.value }) },
              Object.keys(ITERATION_STATUS_LABEL).map(value => h('option', { key: value, value }, ITERATION_STATUS_LABEL[value]))),
          ),
          h('button', { className: 'ds-btn', disabled: busy || iter.name.trim() === '', onClick: () => void addIteration(draft) }, '＋ 加迭代'),
        ),
        h('div', { className: 'ds-hint' }, '迭代改完会立刻反映到看板的迭代筛选。'),
      ),
    ),
  )
}
