/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

import { toDateInput, fromDateInput } from '../roster.js'
import { fmtDate } from '../format.js'
import { client } from '../context.js'
import { RELEASE_STATUS_ORDER, RELEASE_STATUS_LABEL, REQ_STATUS_LABEL } from '../labels.js'

export function ReleasesPage({ state, onOpenTask }) {
  const { h, React, api, toast, confirmDialog, promptDialog, tipOf, TextField, ChipField, CheckField, SelectField, MdField } = client()
  const [items, setItems] = React.useState([])
  const [selected, setSelected] = React.useState(null)
  const [detail, setDetail] = React.useState(null)
  const [form, setForm] = React.useState(null)
  const [notes, setNotes] = React.useState('')
  const [error, setError] = React.useState(null)
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [picker, setPicker] = React.useState('')
  const [smokeText, setSmokeText] = React.useState('')
  const [grayName, setGrayName] = React.useState('')
  const [grayPercent, setGrayPercent] = React.useState('10')
  // 部署环境：只登记「这个版本上过哪个环境」，平台不触发部署。
  const [deployEnv, setDeployEnv] = React.useState('')
  const [deployNote, setDeployNote] = React.useState('')

  const refresh = React.useCallback(async (keepId) => {
    const out = await api('/releases')
    const list = out.releases ?? []
    setItems(list)
    const wanted = keepId ?? (list.some(item => item.id === selected) ? selected : (list[0]?.id ?? null))
    setSelected(wanted)
    if (wanted === null) {
      setDetail(null)
      return
    }
    const one = await api('/release/get', { id: wanted })
    setDetail(one)
    setForm({
      id: one.release.id,
      version: one.release.version,
      name: one.release.name,
      project: one.release.project,
      owner: one.release.owner,
      status: one.release.status,
      plannedAt: one.release.plannedAt,
      tagName: one.release.tagName ?? '',
      commitSha: one.release.commitSha ?? '',
    })
    setNotes(one.release.notes ?? '')
  }, [selected])

  React.useEffect(() => {
    let alive = true
    refresh()
      .then(() => { if (alive) setError(null) })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { alive = false }
  }, [state.revision, refresh])

  async function pick(id) {
    setSelected(id)
    setBusy(true)
    try {
      const one = await api('/release/get', { id })
      setDetail(one)
      setForm({
        id: one.release.id,
        version: one.release.version,
        name: one.release.name,
        project: one.release.project,
        owner: one.release.owner,
        status: one.release.status,
        plannedAt: one.release.plannedAt,
        tagName: one.release.tagName ?? '',
        commitSha: one.release.commitSha ?? '',
      })
      setNotes(one.release.notes ?? '')
      setNotice('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  function createNew() {
    setSelected(null)
    setDetail(null)
    setForm({ id: '', version: '', name: '', project: '', owner: '', status: 'draft', plannedAt: 0, tagName: '', commitSha: '' })
    setNotes('')
    setNotice('')
  }

  async function act(path, body, done) {
    setBusy(true)
    setError(null)
    try {
      const out = await api(path, body)
      setNotice(done ?? '已保存')
      toast(done ?? '已保存')
      toast(done ?? '已保存')
      await refresh(out.release?.id ?? selected)
    } catch (cause) {
      const verb = cause instanceof Error ? cause.message : String(cause)
      setError(verb)
      toast(verb, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (error !== null && items.length === 0) return h('div', { className: 'ds-body' }, h('div', { className: 'ds-err' }, error))

  const gate = detail?.gate
  const release = detail?.release
  const tasks = detail?.tasks ?? []
  const candidates = state.tasks.filter(task => task.releaseId === '' || task.releaseId === undefined)

  const listPane = h('div', { className: 'ds-req-list' },
          
    h('div', { className: 'ds-row', style: { justifyContent: 'space-between', marginBottom: 6 } },
      h('span', { className: 'ds-hint' }, `${items.length} 个版本`),
      h('button', { className: 'ds-btn', onClick: createNew }, '＋ 新建版本'),
    ),
    items.length === 0
      ? h('div', { className: 'ds-empty' }, '还没有版本。先建一个版本，再把卡挂上来。')
      : items.map(item => h('div', {
        key: item.id,
        className: 'ds-req-item',
        'data-on': selected === item.id ? '1' : '0',
        onClick: () => void pick(item.id),
      },
        h('div', { className: 'ds-req-item-title' }, `${item.version || item.id} ${item.name}`.trim()),
        h('div', { className: 'ds-req-item-meta' },
          h(ChipField, { className: 'ds-chip', 'data-kind': item.status }, RELEASE_STATUS_LABEL[item.status] ?? item.status),
          h(ChipField, { className: 'ds-chip' }, `${item.gate.stats.done}/${item.gate.stats.tasks} 卡`),
          item.gate.blockers.length === 0
            ? h(ChipField, { className: 'ds-chip', style: { color: '#0f9d58', borderColor: '#0f9d5855' } }, '门禁通过')
            : h(ChipField, { className: 'ds-chip ds-chip-blocked' }, `${item.gate.blockers.length} 项拦着`),
        ),
      )),
  )

  const detailPane = form === null
    ? h('div', { className: 'ds-hint' }, '左边选一个版本，或者新建一个。')
    : h('div', { className: 'ds-req-detail' },
      // 版本 ↔ 需求：卡上挂着哪条需求，这里就列哪条，不用人再维护一遍。
      (release?.requirements ?? []).length === 0 ? null : h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
        h('span', { className: 'ds-hint' }, `这个版本涉及 ${release.requirements.length} 条需求：`),
        release.requirements.map(req => h('span', {
          key: req.id, className: 'ds-chip', title: req.title,
        }, `${req.code || req.id} ${req.title}（${REQ_STATUS_LABEL[req.derived] ?? req.derived}）`)),
      ),
      h('div', { className: 'ds-req-headline' },
        h('div', null,
          h('div', { className: 'ds-req-name' }, `${form.version || '未编号'} ${form.name}`.trim()),
          h('div', { className: 'ds-hint' }, release === undefined || release === null
            ? '新版本：先填版本号与名字，保存后可以把卡挂进来'
            : `创建于 ${fmtDate(release.createdAt)}${release.releasedAt > 0 ? ` · 发布于 ${fmtDate(release.releasedAt)}` : ''}${release.approveBy !== '' ? ` · 审批人 ${release.approveBy}` : ''}`),
        ),
        h('div', { className: 'ds-req-actions' },
          h(SelectField, {
            className: 'ds-select', style: { width: 108 }, value: form.status,
            onChange: event => setForm({ ...form, status: event.target.value }),
          }, RELEASE_STATUS_ORDER.map(value => h('option', { key: value, value }, RELEASE_STATUS_LABEL[value]))),
        ),
      ),
      h('div', { className: 'ds-panel', style: { marginTop: 4 } },
        h('div', { className: 'ds-panel-head' }, '版本信息'),
        h('div', { className: 'ds-panel-body ds-grid2' },
          h('label', { className: 'ds-field' }, h('span', {}, '版本号'),
            h(TextField, { className: 'ds-input', value: form.version, placeholder: 'v1.3.0', disabled: release?.status === 'released', onChange: event => setForm({ ...form, version: event.target.value }) })),
          h('label', { className: 'ds-field' }, h('span', {}, '版本名'),
            h(TextField, { className: 'ds-input', value: form.name, placeholder: '积分抵扣首个版本', onChange: event => setForm({ ...form, name: event.target.value }) })),
          h('label', { className: 'ds-field' }, h('span', {}, '业务项目'),
            h(SelectField, { className: 'ds-select', value: form.project, onChange: event => setForm({ ...form, project: event.target.value }) },
              h('option', { value: '' }, '不属于任何项目'),
              (state.config.projects ?? []).map(item => h('option', { key: item.id, value: item.id }, item.name)))),
          h('label', { className: 'ds-field' }, h('span', {}, '发布负责人'),
            h(TextField, { className: 'ds-input', value: form.owner, onChange: event => setForm({ ...form, owner: event.target.value }) })),
          h('label', { className: 'ds-field' }, h('span', {}, '计划发布时间'),
            h(TextField, {
              className: 'ds-input', type: 'date', value: toDateInput(form.plannedAt),
              onChange: event => setForm({ ...form, plannedAt: fromDateInput(event.target.value) }),
            })),
          h('label', { className: 'ds-field' }, h('span', {}, '发布标签（tag）'),
            h(TextField, { className: 'ds-input', value: form.tagName ?? '', placeholder: 'v1.0.0', onChange: event => setForm({ ...form, tagName: event.target.value }) })),
          h('label', { className: 'ds-field' }, h('span', {}, '对应提交（sha，选填）'),
            h(TextField, { className: 'ds-input', value: form.commitSha ?? '', placeholder: 'a1b2c3d', onChange: event => setForm({ ...form, commitSha: event.target.value }) })),
          h('div', { className: 'ds-row', style: { alignItems: 'flex-end', justifyContent: 'flex-end', gap: 8 } },
            h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void act('/release/save', { release: form }, '版本已保存') }, '保存'),
            form.id === ''
              ? null
              : h('button', {
                className: 'ds-btn ds-btn-ghost',
                disabled: busy,
                style: { color: 'var(--destructive)' },
                onClick: async () => {
                  const ok = await confirmDialog('删除这个版本？卡会保留，只是脱离版本。', { title: '删除版本', danger: true, okText: '删除' })
                  if (ok) void act('/release/delete', { id: form.id }, '版本已删除')
                },
              }, '删除')),
        ),
      ),
      release === null || release === undefined
        ? null
        : h('div', { className: 'ds-panel', style: { marginTop: 12 } },
          h('div', { className: 'ds-panel-head' }, '发布门禁',
            h('span', { className: 'ds-hint' }, '卡全做完、没阻塞、缺陷关闭、用例没有失败，才算能发')),
          h('div', { className: 'ds-panel-body' },
            h('div', { className: 'ds-req-stats' },
              h('div', { className: 'ds-stat-box' }, h('b', {}, String(gate?.stats.done ?? 0)), h('span', {}, '已完成卡')),
              h('div', { className: 'ds-stat-box' }, h('b', { 'data-warn': (gate?.stats.open ?? 0) > 0 ? '1' : '0' }, String(gate?.stats.open ?? 0)), h('span', {}, '未完成')),
              h('div', { className: 'ds-stat-box' }, h('b', { 'data-warn': (gate?.stats.blocked ?? 0) > 0 ? '1' : '0' }, String(gate?.stats.blocked ?? 0)), h('span', {}, '阻塞')),
              h('div', { className: 'ds-stat-box' }, h('b', { 'data-warn': (gate?.stats.bugs ?? 0) > 0 ? '1' : '0' }, String(gate?.stats.bugs ?? 0)), h('span', {}, '未结缺陷')),
              h('div', { className: 'ds-stat-box' }, h('b', { 'data-warn': (gate?.stats.failing ?? 0) > 0 ? '1' : '0' }, String(gate?.stats.failing ?? 0)), h('span', {}, '失败用例')),
              h('div', { className: 'ds-stat-box' }, h('b', {}, String(gate?.stats.artifacts ?? 0)), h('span', {}, '交付物')),
            ),
            (gate?.blockers ?? []).map((line, index) => h('div', { key: `b${index}`, className: 'ds-error' }, `⛔ ${line}`)),
            (gate?.warnings ?? []).map((line, index) => h('div', { key: `w${index}`, className: 'ds-hint' }, `⚠ ${line}`)),
            h('div', { className: 'ds-action-bar' },
              h('div', { className: 'ds-action-bar-left' },
                h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void act('/release/notes', { id: form.id }, '发布说明已生成') }, '生成发布说明'),
                h('button', { className: 'ds-btn', disabled: busy || !gate?.ready, onClick: () => void act('/release/approve', { id: form.id, by: '人' }, '已审批，可以发布了') }, '审批通过'),
              ),
              h('div', { className: 'ds-action-bar-right' },
              h('button', { className: 'ds-btn ds-btn-primary', disabled: busy || !gate?.ready || release.status === 'released', onClick: () => void act('/release/publish', { id: form.id, by: '人' }, '已发布') }, release.status === 'released' ? '已发布' : '发布'),
              tipOf('发布准入（预发部署 / 需求签字）没过时也要发：必须写原因，会记进部署日志', h('button', {
                className: 'ds-btn ds-btn-ghost',
                disabled: busy || !gate?.ready || release.status === 'released',
                'data-force': '1',
                onClick: async () => {
                  const reason = await promptDialog('强制发布的原因（会记进部署日志，便于复盘）：', { title: '强制发布', okText: '强制发布', placeholder: '为什么不等预发部署 / 需求签字？' })
                  if (reason === null) return
                  if (String(reason).trim() === '') { setNotice('强制发布必须写原因'); return }
                  void act('/release/publish', { id: form.id, by: '人', force: true, forceNote: String(reason).trim() }, '已强制发布（原因已记入部署日志）')
                },
              }, '强制发布')),
              release.status === 'released'
                ? h('button', {
                  className: 'ds-btn ds-btn-ghost', disabled: busy,
                  onClick: async () => {
                    const reason = await promptDialog('回滚原因（要进复盘记录）：', { title: '回滚这个版本', danger: true, okText: '回滚' })
                    if (reason !== null && reason.trim() !== '') void act('/release/rollback', { id: form.id, reason }, '已回滚')
                  },
                }, '回滚')
                : null,
              ),
            ),
            release.rollbackReason === '' ? null : h('div', { className: 'ds-error' }, `回滚原因：${release.rollbackReason}`),
          ),
        ),
      release === null || release === undefined
        ? null
        : h('div', { className: 'ds-panel', style: { marginTop: 12 } },
          h('div', { className: 'ds-panel-head' }, '发布冒烟清单',
            h('span', { className: 'ds-hint' }, `${(release.smoke ?? []).filter(item => item.done).length}/${(release.smoke ?? []).length} 项已过 · 发布前逐条点过，门禁才算过`)),
          h('div', { className: 'ds-panel-body' },
            (release.smoke ?? []).length === 0
              ? h('div', { className: 'ds-empty' }, '还没有冒烟项：把发布前必验的几条写在这里，比如「能登录」「下单支付成功」「首页不报错」。')
              : null,
            (release.smoke ?? []).map(item => h('div', { key: item.id, className: 'ds-listrow' },
              h('label', { className: 'ds-row', style: { gap: 8, alignItems: 'center', flex: 1, cursor: 'pointer' } },
                h(CheckField, { checked: item.done === true,
                  onChange: () => void act('/release/smoke', { id: form.id, action: 'toggle', itemId: item.id, done: item.done !== true, by: '人' }, item.done ? '已取消' : '冒烟项已过'),
                }),
                h('span', { className: item.done ? 'ds-smoke-done' : '' }, item.text),
              ),
              item.done && item.by !== '' ? h('span', { className: 'ds-hint' }, `${item.by} · ${fmtDate(item.at)}`) : null,
              h('div', { className: 'ds-listrow-actions' },
                h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void act('/release/smoke', { id: form.id, action: 'remove', itemId: item.id }, '已删除') }, '×')),
            )),
            h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8 } },
              h(TextField, {
                className: 'ds-input', style: { flex: 1 }, value: smokeText,
                placeholder: '发布前必须验证什么？', onChange: event => setSmokeText(event.target.value),
              }),
              h('button', {
                className: 'ds-btn', disabled: busy || smokeText.trim() === '',
                onClick: () => {
                  const label = smokeText.trim()
                  if (label === '') return
                  setSmokeText('')
                  void act('/release/smoke', { id: form.id, action: 'add', text: label }, '已加冒烟项')
                },
              }, '＋ 加一条')),
          ),
        ),
      release === null || release === undefined
        ? null
        : h('div', { className: 'ds-panel', style: { marginTop: 12 } },
          h('div', { className: 'ds-panel-head' }, '审批、灰度与部署记录',
            h('span', { className: 'ds-hint' }, `审批 ${(release.approvals ?? []).length} 条 · 灰度 ${(release.grayBatches ?? []).length} 批`)),
          h('div', { className: 'ds-panel-body' },
            (release.approvals ?? []).length === 0
              ? h('div', { className: 'ds-empty' }, '还没有审批记录：点上面的「审批通过」，系统会把谁批的、什么结论记在这里。')
              : (release.approvals ?? []).map(item => h('div', { key: item.id, className: 'ds-listrow' },
                h('div', { className: 'ds-listrow-main' },
                  h('div', null, `${item.by} 审批通过`),
                  h('div', { className: 'ds-hint' }, item.note || '（没写结论）'),
                ),
                h('span', { className: 'ds-hint' }, fmtDate(item.at)),
              )),
            h('div', { style: { borderTop: '1px solid var(--ds-line)', margin: '10px 0' } }),
            (release.grayBatches ?? []).length === 0
              ? h('div', { className: 'ds-hint' }, '没有灰度批次：发布就是一次性全量。先加一批 10% 跑一轮再全量，出事好收。')
              : (release.grayBatches ?? []).map(item => h('div', { key: item.id, className: 'ds-listrow' },
                h('div', { className: 'ds-listrow-main' },
                  h('div', null, `${item.name} · ${item.percent}%`),
                  h('div', { className: 'ds-hint' }, `${({ pending: '待开始', running: '灰度中', passed: '已通过', rolled_back: '已回滚' })[item.status] ?? item.status}${item.note === '' ? '' : ` · ${item.note}`}`),
                ),
                h('div', { className: 'ds-listrow-actions' },
                  item.status === 'pending' ? h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void act('/release/gray', { id: form.id, action: 'start', batchId: item.id, by: '人' }, '已开始灰度') }, '开始') : null,
                  item.status === 'running' ? h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void act('/release/gray', { id: form.id, action: 'advance', batchId: item.id, by: '人' }, '这一批已通过') }, '通过') : null,
                  item.status === 'passed' ? h(ChipField, { className: 'ds-chip', 'data-on': '1' }, '已通过') : null,
                  item.status === 'rolled_back' ? h(ChipField, { className: 'ds-chip', 'data-sla': 'overdue' }, '已回滚') : null,
                ),
              )),
            h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8 } },
              h(TextField, {
                className: 'ds-input', style: { flex: 2 }, value: grayName,
                placeholder: '批次名，例如 内测用户', onChange: event => setGrayName(event.target.value),
              }),
              h(TextField, {
                className: 'ds-input', style: { flex: '0 0 88px' }, type: 'number', min: 1, max: 100,
                value: grayPercent, onChange: event => setGrayPercent(event.target.value),
              }),
              h('button', {
                className: 'ds-btn', disabled: busy || Number(grayPercent) <= 0,
                onClick: async () => {
                  await act('/release/gray', { id: form.id, action: 'add', name: grayName, percent: Number(grayPercent), by: '人' }, '已加一批灰度')
                  setGrayName('')
                  setGrayPercent('10')
                },
              }, '＋ 加一批'),
            ),
            h('div', { style: { borderTop: '1px solid var(--ds-line)', margin: '10px 0' } }),
            // 部署环境：这里只留痕，平台不接 CD，也不会去调任何部署脚本。
            h('div', { className: 'ds-hint' }, '上过哪些环境（只登记，不触发部署）'),
            (release.deploys ?? []).length === 0 ? null : h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 6, marginTop: 6 } },
              release.deploys.map(item => h('span', {
                key: item.id,
                className: 'ds-chip',
                'data-env': item.kind,
                'data-on': item.at === 0 ? '0' : '1',
                title: item.at === 0 ? `还没登记部署到「${item.name}」` : `${item.name}：${fmtDate(item.at)} ${item.action} · ${item.by}`,
              }, item.at === 0 ? `${item.name} —` : `${item.name} ✓`)),
            ),
            h('div', { className: 'ds-row', style: { gap: 8, marginTop: 8 } },
              h(SelectField, {
                className: 'ds-input', style: { flex: '0 0 148px' }, value: deployEnv,
                onChange: event => setDeployEnv(event.target.value),
              },
                h('option', { value: '' }, '选环境…'),
                (state.config?.environments ?? []).map(env => h('option', { key: env.id, value: env.id }, env.name)),
              ),
              h(TextField, {
                className: 'ds-input', style: { flex: 1 }, value: deployNote,
                placeholder: '备注：谁发的、发了什么（可留空）',
                onChange: event => setDeployNote(event.target.value),
              }),
              h('button', {
                className: 'ds-btn', disabled: busy || deployEnv === '',
                onClick: async () => {
                  await act('/release/deploy', { id: form.id, env: deployEnv, note: deployNote, by: '人' }, '已登记部署（没有触发任何部署）')
                  setDeployNote('')
                },
              }, '登记部署'),
            ),
            h('div', { className: 'ds-hint', style: { marginTop: 10 } }, '部署与灰度记录（最近 8 条）'),
            (() => {
              const GRAY = { pending: '待开始', running: '灰度中', passed: '已通过', rolled_back: '已回滚' }
              const rows = [
                ...(release.deployLog ?? []).map(item => ({ at: item.at, kind: 'deploy', by: item.by, text: `${item.action}${item.env === '' ? '' : ` · ${(state.config?.environments ?? []).find(env => env.id === item.env)?.name ?? item.env}`}`, note: item.note })),
                ...(release.grayBatches ?? []).map(item => ({ at: item.at ?? item.createdAt ?? 0, kind: 'gray', by: item.by ?? '人', text: `灰度 ${item.name} ${item.percent}%`, note: GRAY[item.status] ?? item.status })),
              ].filter(entry => entry.at).sort((a, b) => a.at - b.at).slice(-8).reverse()
              if (rows.length === 0) return h('div', { className: 'ds-empty' }, '还没有部署或灰度记录。')
              return rows.map(entry => h('div', { key: `${entry.at}-${entry.kind}-${entry.text}`, className: 'ds-hint' },
                h('span', { className: 'ds-chip', style: { marginRight: 6 } }, entry.kind === 'gray' ? '灰度' : '部署'),
                `${fmtDate(entry.at)} · ${entry.text} · ${entry.by}${entry.note === '' || entry.note === undefined ? '' : `：${entry.note}`}`))
            })(),
          ),
        ),
      release === null || release === undefined
        ? null
        : h('div', { className: 'ds-panel', style: { marginTop: 12 } },
          h('div', { className: 'ds-panel-head' }, '这个版本里的卡', h('span', { className: 'ds-hint' }, `${tasks.length} 张`)),
          h('div', { className: 'ds-panel-body' },
            tasks.length === 0
              ? h('div', { className: 'ds-empty' }, '还没有卡。从下面挑，或者在卡片详情里选「所属版本」。')
              : tasks.map(task => h('div', { key: task.id, className: 'ds-listrow' },
                h('div', { className: 'ds-listrow-main' },
                  h('div', null, `${task.code ? `${task.code} ` : ''}${task.title}`),
                  h('div', { className: 'ds-hint' }, `${(state.statuses ?? []).find(entry => entry.id === task.status)?.label ?? task.status}${task.blocked !== null && task.blocked !== undefined ? ' · 阻塞' : ''}${task.type === 'bug' ? ' · 缺陷' : ''}`),
                ),
                h('div', { className: 'ds-listrow-actions' },
                  h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => onOpenTask(task.id) }, '打开'),
                  h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void act('/release/link', { id: form.id, taskId: task.id, action: 'remove' }, '已从版本移除') }, '移除'),
                ),
              )),
            h('div', { className: 'ds-row', style: { marginTop: 8 } },
              h(SelectField, {
                className: 'ds-select', style: { flex: 1 }, value: picker,
                onChange: event => setPicker(event.target.value),
              },
                h('option', { value: '' }, `挑一张卡挂进来（${candidates.length} 张可选）`),
                candidates.map(task => h('option', { key: task.id, value: task.id }, `${task.code ? `${task.code} ` : ''}${task.title}`)),
              ),
              h('button', {
                className: 'ds-btn', disabled: busy || picker === '',
                onClick: async () => {
                  await act('/release/link', { id: form.id, taskId: picker, action: 'add' }, '已挂到这个版本')
                  setPicker('')
                },
              }, '挂进来'),
            ),
          ),
        ),
      release === null || release === undefined
        ? null
        : h('div', { className: 'ds-panel', style: { marginTop: 12 } },
          h('div', { className: 'ds-panel-head' }, '发布说明',
            h('button', {
              className: 'ds-btn ds-btn-ghost', disabled: busy,
              onClick: () => void navigator.clipboard?.writeText(notes).then(() => setNotice('发布说明已复制'), () => undefined),
            }, '复制')),
          h('div', { className: 'ds-panel-body' },
            h(MdField, {
              className: 'ds-input', rows: 12, value: notes,
              placeholder: '点「生成发布说明」按类型自动汇总；之后可以在这里手动补充',
              onChange: event => setNotes(event.target.value),
              onBlur: () => { if (notes !== (release.notes ?? '')) void act('/release/save', { release: { ...form, notes } }, '发布说明已保存') },
            })),
        ),
      error === null ? null : h('div', { className: 'ds-error', style: { marginTop: 8 } }, error),
      notice === '' ? null : h('div', { className: 'ds-hint', style: { marginTop: 8 } }, notice),
    )

  return h('div', { className: 'ds-body' },
    h('div', { className: 'ds-req-grid' }, listPane, detailPane),
  )
}
