/* Settings panels lifted out of client.src.js; shared handles come from the studio context. */

import { ROLE_LABEL } from '../labels.js'
import { buildRoster, filterRoster } from '../roster.js'
import { fmtTime } from '../format.js'
import { client } from '../context.js'

export function AccessPanel({ state, config, onChanged }) {
  const { h, sessionToken, api, toast, currentUser, confirmDialog, TextField, ChipField, CheckField, SelectField } = client()
  const access = config.access ?? { enabled: false, members: [] }
  const audit = state.audit ?? []
  const [draft, setDraft] = React.useState({ name: '', role: 'member' })
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState(null)
  const [onlyBy, setOnlyBy] = React.useState('')
  const [onlyFailed, setOnlyFailed] = React.useState(false)
  const [queryText, setQueryText] = React.useState('')

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
  const rows = matched.slice(0, 120)

  // 走服务端导出：http 页面里的 blob 下载会被 Chrome 拦，服务端 Content-Disposition 才稳
  const exportCsv = () => {
    const params = new URLSearchParams({
      by: onlyBy, q: queryText.trim(), failed: onlyFailed ? '1' : '0',
      token: sessionToken() ?? '',
    })
    const anchor = document.createElement('a')
    anchor.href = `${API}/audit/export.csv?${params.toString()}`
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    toast(`正在导出 ${matched.length} 条审计记录`)
  }

  return h('div', { className: 'ds-pane-stack' },
    h('div', { className: 'ds-panel ds-form-panel' },
      h('div', { className: 'ds-panel-head' },
        h('span', null, '成员权限'),
        h(ChipField, { className: 'ds-chip' }, `当前身份：${currentUser()}`),
      ),
      h('div', { className: 'ds-panel-body' },
        h('div', { className: 'ds-row', style: { gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('label', { className: 'ds-check', style: { flex: '0 0 auto' } },
            h(CheckField, { checked: access.enabled === true, disabled: busy,
              onChange: event => void act('/access/save', { enabled: event.target.checked }),
            }),
            h('span', null, '启用成员权限'),
          ),
          h('span', { className: 'ds-hint' },
            access.enabled === true
              ? '已启用：写操作要认人，删除/配置/发布要管理员。'
              : '未启用：任何人都是管理员（单机用法）。'),
        ),
        access.enabled === true && (access.members ?? []).length === 0
          ? h('div', { className: 'ds-error' }, '已启用但名单是空的：除了名单里的人，其他人都动不了。先把你自己加进去。')
          : null,
        access.enabled === true
          ? h('label', { className: 'ds-check' },
              h(CheckField, { checked: (access.agents ?? 'inherit') === 'inherit',
                disabled: busy,
                onChange: event => void act('/access/save', { agents: event.target.checked ? 'inherit' : 'bypass' }),
              }),
              h('span', null, 'AI 专家也受这份名单约束'),
            )
          : null,
        access.enabled === true
          ? h('div', { className: 'ds-hint' }, (access.agents ?? 'inherit') === 'inherit'
              ? '专家调工具时按同一张名单判权限：只读专家只能看，成员能干活，管理员才能改配置。名单里没有的专家会被拦下，记得在下面加进去。'
              : '已豁免：专家调用工具不受名单限制，但仍记审计。适合「全交给 AI」的团队。')
          : null,
        (access.members ?? []).map(member => h('div', { key: member.name, className: 'ds-listrow' },
          h('div', { className: 'ds-listrow-main' },
            h('div', null, member.name, member.name === currentUser() ? h(ChipField, { className: 'ds-chip ds-chip-soft' }, '我') : null),
            h('div', { className: 'ds-hint' }, (ACCESS_ROLE_OPTIONS.find(item => item.id === member.role) ?? ACCESS_ROLE_OPTIONS[1]).hint),
          ),
          h('div', { className: 'ds-listrow-actions' },
            h(SelectField, {
              className: 'ds-select', value: member.role, disabled: busy,
              onChange: event => void act('/access/save', { member: { name: member.name, role: event.target.value } }),
            }, ACCESS_ROLE_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.label))),
            h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void act('/access/delete', { name: member.name }) }, '移除'),
          ),
        )),
        (access.members ?? []).length === 0 ? h('div', { className: 'ds-empty' }, '还没有成员。') : null,
        h('div', { className: 'ds-row', style: { gap: 8, flexWrap: 'wrap' } },
          h(TextField, {
            className: 'ds-input', placeholder: '成员名字（和页头「👤 我是…」一致）', value: draft.name,
            style: { flex: '1 1 200px' },
            onChange: event => setDraft({ ...draft, name: event.target.value }),
          }),
          h(SelectField, {
            className: 'ds-select', value: draft.role, style: { flex: '0 0 130px' },
            onChange: event => setDraft({ ...draft, role: event.target.value }),
          }, ACCESS_ROLE_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.label))),
          h('button', { className: 'ds-btn ds-btn-primary', disabled: busy || draft.name.trim() === '', onClick: () => void addMember() }, '加成员'),
        ),
        note !== null ? h('div', { className: 'ds-error' }, note) : null,
      ),
    ),
    h('div', { className: 'ds-panel' },
      h('div', { className: 'ds-panel-head' },
        h('span', null, `审计日志（显示 ${rows.length} / 命中 ${matched.length} / 共 ${audit.length} 条）`),
        h('div', { className: 'ds-row', style: { gap: 8, marginLeft: 'auto' } },
          h(TextField, {
            className: 'ds-input', placeholder: '搜动作 / 人 / 详情',
            value: queryText, style: { width: 170 },
            onChange: event => setQueryText(event.target.value),
          }),
          h(SelectField, {
            className: 'ds-select', value: onlyBy === '' ? '__all__' : onlyBy, style: { minWidth: 150 },
            onChange: event => setOnlyBy(event.target.value === '__all__' ? '' : event.target.value),
          },
          h('option', { value: '__all__' }, '所有人'),
          people.map(name => h('option', { key: name, value: name }, name))),
          h('label', { className: 'ds-check' },
            h(CheckField, { checked: onlyFailed, onChange: event => setOnlyFailed(event.target.checked) }),
            h('span', null, '只看失败'),
          ),
          h('button', {
            className: 'ds-btn ds-btn-ghost', disabled: busy,
            onClick: async () => { if (await confirmDialog('清空审计日志？清掉之后所有操作记录都没了。', { title: '清空审计日志', danger: true, okText: '清空' })) void act('/audit/clear', {}) },
          }, '清空'),
          h('button', {
            className: 'ds-btn ds-btn-ghost', disabled: matched.length === 0, onClick: exportCsv,
            title: '把当前筛选结果导出为 CSV（Excel 可直接打开）',
          }, '导出 CSV'),
        ),
      ),
      h('div', { className: 'ds-panel-body' },
        rows.length === 0
          ? h('div', { className: 'ds-empty' }, audit.length === 0
            ? '还没有记录。做一次写操作就会出现在这里。'
            : '没有符合筛选条件的记录。把关键字清空或换个人试试。')
          : rows.map(item => h('div', { key: item.id, className: 'ds-audit-row', 'data-ok': item.ok ? '1' : '0' },
            h('span', { className: 'ds-audit-time' }, fmtTime(item.at)),
            h('span', { className: 'ds-audit-by' }, item.by),
            h('span', { className: 'ds-audit-what' }, ROUTE_LABEL[item.route] ?? item.route),
            h('span', { className: 'ds-audit-detail' }, item.summary),
            h('span', { className: 'ds-audit-status', 'data-ok': item.ok ? '1' : '0' }, item.ok ? '成功' : `失败 ${item.status}`),
          )),
      ),
    ),
  )
}

export function ColumnsPanel({ state, onChanged }) {
  const { h, sessionToken, api, toast, currentUser, confirmDialog, TextField, ChipField, CheckField, SelectField } = client()
  const config = state.config
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
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
    if (member.kind === 'role') return '🎯 ' + (ROLE_LABEL[member.id] ?? member.id)
    if (member.kind === 'team') {
      const team = (config.teams ?? []).find(entry => entry.id === member.id)
      return team === undefined ? `👥 ${member.id}` : `${team.emoji ?? '👥'} ${team.name}`
    }
    const expert = (config.experts ?? []).find(entry => entry.id === member.id)
    return expert === undefined ? member.id : `${expert.emoji} ${expert.name}`
  }
  const save = async (status, members, strategy) => {
    setBusy(true); setError(null)
    try {
      await api('/columns/save', { status, members, strategy })
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

  return h('div', { className: 'ds-panel' },
    h('div', { className: 'ds-panel-head' }, '每一列由谁负责'),
    h('div', { className: 'ds-panel-body' },
      h('div', { className: 'ds-hint' }, '推荐挂「角色位」：澄清/验收挂产品经理、开发挂研发工程师、测试挂测试工程师——派单时会按卡片的业务领域自动挑对应领域专家（如支付产品经理）；也可以直接指定某位专家或专家团。一列可挂多人（候选池），一个都不挂就只把卡停在原地等人认领。'),
      statuses.map(column => {
        const members = membersOf(column.id)
        const strategy = strategyOf(column.id)
        return h('div', { className: 'ds-colrow', key: column.id },
          h('div', { className: 'ds-colrow-head' },
            h('span', { className: 'ds-colrow-name' }, column.label ?? column.id),
            members.length === 0
              ? h('span', { className: 'ds-hint' }, '👤 等人认领（不自动派）')
              : members.map((member, index) => h(ChipField, { className: 'ds-chip ds-chip-owner', key: `${member.kind}:${member.id}` },
                labelOf(member),
                h('button', {
                  className: 'ds-chip-x', title: '从候选里去掉', disabled: busy,
                  onClick: () => remove(column.id, index),
                }, '×'),
              )),
            h('button', {
              className: 'ds-btn', style: { marginLeft: 'auto' }, disabled: busy,
              onClick: () => { setQuery(''); setOpenFor(current => current === column.id ? null : column.id) },
            }, openFor === column.id ? '收起' : '＋ 加候选'),
            members.length >= 2
              ? h(SelectField, {
                className: 'ds-input', style: { width: 240 }, value: strategy, disabled: busy,
                onChange: e => void save(column.id, members, e.target.value),
              }, STRATEGIES.map(entry => h('option', { key: entry.id, value: entry.id }, entry.label)))
              : null,
          ),
          openFor === column.id
            ? h('div', { className: 'ds-colpick' },
              h(TextField, {
                className: 'ds-mention-search', autoFocus: true, value: query,
                placeholder: '搜专家或专家团，点一下加进候选',
                onChange: e => setQuery(e.target.value),
              }),
              h('div', { className: 'ds-colpick-list' },
                filterRoster(roster, query).length === 0
                  ? h('div', { className: 'ds-mention-empty' }, '没有匹配的专家或专家团')
                  : filterRoster(roster, query).map(item => h('button', {
                    key: item.key, className: 'ds-mention-item', onClick: () => add(column.id, item),
                  }, h('span', null, item.emoji), h('span', null, item.name), h('span', { className: 'ds-hint' }, item.hint))),
              ),
            )
            : null,
        )
      }),
      error !== null ? h('div', { className: 'ds-error' }, error) : null,
    ),
  )
}

/** 数据与备份：看台账存在哪、密钥在哪，以及回滚到某个快照。 */
export function StoragePanel({ state, onChanged }) {
  const { h, sessionToken, api, toast, currentUser, confirmDialog, TextField, ChipField, CheckField, SelectField } = client()
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

  return h('div', { className: 'ds-pane-stack' },
    h('div', { className: 'ds-panel ds-form-panel' },
      h('div', { className: 'ds-panel-head' }, '台账存储', h(ChipField, { className: 'ds-chip', 'data-on': info?.engine === 'sqlite' ? '1' : '0' }, info?.engine === 'sqlite' ? 'SQLite' : '单文件')),
      h('div', { className: 'ds-panel-body' },
        h('div', { className: 'ds-an-kv' }, h('span', {}, '数据文件'), h('b', {}, info?.db ?? '—')),
        h('div', { className: 'ds-an-kv' }, h('span', {}, '密钥文件（600 权限，明文不进台账）'), h('b', {}, info?.secretsFile ?? '—')),
        h('div', { className: 'ds-an-kv' }, h('span', {}, '保留快照'), h('b', {}, `${info?.snapshots ?? 0} / ${info?.snapshotLimit ?? 0}`)),
        h('div', { className: 'ds-hint' }, '每次写操作都会在同一个事务里先存一份快照，再更新台账；多进程同时写会排队（busy_timeout 5s），不会互相覆盖。'),
      ),
    ),
    h('div', { className: 'ds-panel' },
      h('div', { className: 'ds-panel-head' },
        '快照',
        h('button', { className: 'ds-btn ds-btn-ghost', style: { marginLeft: 'auto' }, onClick: load, disabled: busy }, '刷新'),
      ),
      h('div', { className: 'ds-panel-body' },
        notice !== null ? h('div', { className: 'ds-ok' }, notice) : null,
        error !== null ? h('div', { className: 'ds-error' }, error) : null,
        snapshots.length === 0
          ? h('div', { className: 'ds-hint' }, info?.engine === 'sqlite' ? '还没有快照。' : '单文件模式没有快照（这台机器的 node 不支持 node:sqlite 时会退回单文件）。')
          : snapshots.map(item => h('div', { key: item.id, className: 'ds-listrow' },
            h('div', { className: 'ds-listrow-main' },
              h('div', null, `#${item.id} · rev ${item.revision}`),
              h('div', { className: 'ds-hint' }, `${when(item.at)} · ${(item.bytes / 1024).toFixed(1)} KB`),
            ),
            h('div', { className: 'ds-listrow-actions' },
              h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => restore(item.id) }, '回滚到这版'),
            ),
          )),
      ),
    ),
  )
}

/** 集成健康：哪条通道在掉、什么时候掉的、还能不能补一次。 */
export function HealthPanel({ state, config, onChanged }) {
  const { h, sessionToken, api, toast, currentUser, confirmDialog, TextField, ChipField, CheckField, SelectField } = client()
  const health = state.integrations ?? { channels: [], broken: 0 }
  const [busy, setBusy] = React.useState('')
  const [note, setNote] = React.useState(null)
  const firstRequirement = (state.requirements ?? []).find(item => (item.folder?.token ?? '') !== '')
  const agents = state.agents ?? {}
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
    anchor.href = `${API}/export/dispatch.csv?${params.toString()}`
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
        setNote(out.report === undefined ? '已触发 GitLab 同步' : `已同步：${(out.report.projects ?? []).map(item => `${item.name} +${item.created}`).join('，') || '无新卡'}`)
      } else if (channel === 'drive') {
        if (firstRequirement === undefined) {
          setNote('还没有带云盘文件夹的需求，先建一条需求并归档一次。')
        } else {
          const out = await api('/requirement/sync', { id: firstRequirement.id })
          setNote(`已归档 ${out.report?.written ?? 0} / ${out.report?.total ?? 0} 件`); toast(`已归档 ${out.report?.written ?? 0} / ${out.report?.total ?? 0} 件`)
        }
      } else if (channel === 'feishu') {
        const out = await api('/feishu/test', {})
        setNote(out.ok === true ? '测试消息已发出' : `发送失败：${out.result?.error ?? '没配置机器人'}`)
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

  const LABEL = { ok: '正常', error: '异常', idle: '还没用过' }
  const COLOR = { ok: '#0f9d58', error: '#e5484d', idle: '#8a8f98' }

  return h('div', { className: 'ds-pane-stack' },
    h('div', { className: 'ds-panel' },
      h('div', { className: 'ds-panel-head' },
        '派单运行状态',
        h(ChipField, { className: 'ds-chip', 'data-on': agents.enabled === true ? '1' : '0' },
          agents.enabled === true ? '运行中' : '已停用'),
        h('div', { className: 'ds-row', style: { gap: 8, marginLeft: 'auto' } },
          h(TextField, {
            className: 'ds-input', placeholder: '搜派单日志',
            value: logQuery, style: { width: 150 },
            onChange: event => setLogQuery(event.target.value),
          }),
          h('label', { className: 'ds-check' },
            h(CheckField, { checked: logFailed, onChange: event => setLogFailed(event.target.checked) }),
            h('span', null, '只看失败'),
          ),
          h('button', {
            className: 'ds-btn ds-btn-ghost', disabled: logRows.length === 0, onClick: exportLogCsv,
            title: '把当前筛选结果导出为 CSV',
          }, '导出 CSV'),
        ),
      ),
      h('div', { className: 'ds-panel-body' },
        h('div', { className: 'ds-kv' },
          h('dt', {}, '实例'), h('dd', {}, String(agents.instance ?? '—')),
          h('dt', {}, '派单锁'),
          h('dd', {}, lock === null
            ? '还没抢到过（可能是内存模式）'
            : `${lock.mine === true ? '本进程持有' : '其他实例持有'} · ${Math.round(lockAge / 1000)} 秒前续租`),
          h('dt', {}, '并发占用'), h('dd', {}, `${(agents.running ?? []).length} / ${agents.maxConcurrent ?? '—'}`),
          h('dt', {}, '最近一轮'), h('dd', {}, when(agents.lastTickAt)),
          h('dt', {}, '最近错误'), h('dd', {}, String(agents.lastError ?? '') === '' ? '无' : String(agents.lastError)),
        ),
        (agents.log ?? []).length === 0
          ? h('div', { className: 'ds-empty' }, '还没有派单日志。卡进入自动列后，这里会出现派单、空闲、失败记录。')
          : logShown.length === 0
            ? h('div', { className: 'ds-empty' }, '没有符合筛选条件的派单日志。')
            : h('div', { className: 'ds-log' },
              logShown.map((entry, index) => h('div', {
                key: String(index),
                className: 'ds-log-line',
              }, `${when(entry.at)} · ${String(entry.line ?? '')}`)),
            ),
        (agents.log ?? []).length > 0 && logRows.length > logShown.length
          ? h('div', { className: 'ds-hint' }, `只显示最近 ${logShown.length} / 命中 ${logRows.length} 条，导出可看全量`)
          : null,
      ),
    ),
    h('div', { className: 'ds-panel' },
      h('div', { className: 'ds-panel-head' },
        '集成状态',
        h(ChipField, { className: 'ds-chip', 'data-on': health.broken === 0 ? '1' : '0' },
          health.broken === 0 ? '全部正常' : `${health.broken} 条异常`),
        h('button', { className: 'ds-btn ds-btn-ghost', style: { marginLeft: 'auto' }, onClick: () => void onChanged() }, '刷新'),
      ),
      h('div', { className: 'ds-panel-body' },
        note !== null ? h('div', { className: 'ds-hint' }, note) : null,
        health.channels.length === 0
          ? h('div', { className: 'ds-empty' }, '还没有调用过任何外部集成。配好 GitLab / 飞书机器人 / 云盘文件夹后，第一次成功或失败就会出现在这里。')
          : health.channels.map(item => h('div', { key: item.channel, className: 'ds-listrow' },
              h('div', { className: 'ds-listrow-main' },
                h('div', null,
                  h('span', { style: { color: COLOR[item.state], fontWeight: 700 } }, '● '),
                  item.label,
                  h(ChipField, { className: 'ds-chip ds-chip-soft', style: { marginLeft: 6 } }, LABEL[item.state])),
                h('div', { className: 'ds-hint' }, item.hint),
                h('div', { className: 'ds-hint' },
                  `最近一次：${when(item.at)} · 成功 ${when(item.lastOkAt)} · 失败 ${when(item.lastErrorAt)}${item.attempts > 0 ? ` · 试着调了 ${item.attempts} 次，连挂 ${item.failures} 次` : ''}`),
                item.lastError === '' ? null : h('div', { className: 'ds-error' }, item.lastError),
              ),
              h('div', { className: 'ds-listrow-actions' },
                h('button', {
                  className: 'ds-btn ds-btn-ghost', disabled: busy !== '',
                  onClick: () => void retry(item.channel),
                }, busy === item.channel ? '重试中…' : '再试一次'),
              ),
            )),
      ),
    ),
    h('div', { className: 'ds-panel ds-form-panel' },
      h('div', { className: 'ds-panel-head' }, '失败了会怎样'),
      h('div', { className: 'ds-panel-body' },
        h('div', { className: 'ds-hint' }, '· 飞书通知：同一条消息会自动重发一次，两次都失败才记异常（飞书 200 但 body 里 code≠0 也算失败）。'),
        h('div', { className: 'ds-hint' }, '· GitLab：拉 Issue、回写评论、对 MR 失败会记在这里；同步定时器仍会自动重试下一轮。'),
        h('div', { className: 'ds-hint' }, '· 飞书云盘：归档失败会挂在交付物自身的 doc.error 上，这里再汇总一份。'),
        h('div', { className: 'ds-hint' }, '· 代码隔离：worktree 建失败只影响这一张卡（退回普通工作区），不影响别的卡。'),
      ),
    ),
  )
}
