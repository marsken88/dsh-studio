/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

import { toDateInput, fromDateInput } from '../roster.js'
import { fmtDate } from '../format.js'
import { client } from '../context.js'
import { RELEASE_STATUS_ORDER, RELEASE_STATUS_LABEL, REQ_STATUS_LABEL } from '../labels.js'
import { Button, Select, Chip } from '../../boardui/index'
import { EmptyState } from '../../boardui/empty-state'

/* 整页 BoardUI：面板/表单/列表/动作全部走 token + Tailwind（4px 档位），不再写手写类。 */
/* [&>*]:shrink-0 —— 纵向 flex 默认会压缩子项：内容高于视口时每个分区被压扁，
   而分区自己 overflow-hidden，里面的内容就被裁掉（工作台出现「空条」的根因）。 */
const PAGE = 'flex min-w-0 flex-col gap-4 overflow-auto p-4 [&>*]:shrink-0'
const PANEL = 'flex min-w-0 flex-col overflow-hidden rounded-xl border border-separator-border bg-background-primary-default'
const PANEL_HEAD = 'flex flex-wrap items-center gap-2 border-b border-separator-border px-4 py-3 text-body-2-medium text-text-primary'
const PANEL_BODY = 'flex min-w-0 flex-col gap-3 p-4'
const HINT = 'text-caption-1-regular text-text-tertiary'
const LABEL = 'text-caption-1-medium text-text-secondary'
const FIELD = 'flex min-w-0 flex-col gap-1'
const ROW = 'flex min-w-0 flex-wrap items-center gap-2'
const ACTIONS = 'flex flex-wrap items-center gap-2'
const LISTROW = 'flex min-w-0 items-start justify-between gap-4 border-b border-separator-border py-3 last:border-b-0'
const LISTROW_MAIN = 'flex min-w-0 flex-1 flex-col gap-1'
const STATBOX = 'flex min-w-0 flex-col gap-1 rounded-lg border border-separator-border bg-background-primary-default px-3 py-2'
const STATVALUE = 'text-title-2-semibold text-text-primary tabular-nums'

export function ReleasesPage({ state, onOpenTask }) {
  const { h, React, api, toast, confirmDialog, promptDialog, tipOf, TextField, CheckField, MdField } = client()
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
      await refresh(out.release?.id ?? selected)
    } catch (cause) {
      const verb = cause instanceof Error ? cause.message : String(cause)
      setError(verb)
      toast(verb, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (error !== null && items.length === 0) return h('div', { className: PAGE, 'data-releases-page': '' }, h('div', { className: 'text-caption-1-regular text-text-error-primary' }, error))

  const gate = detail?.gate
  const release = detail?.release
  const tasks = detail?.tasks ?? []
  const candidates = state.tasks.filter(task => task.releaseId === '' || task.releaseId === undefined)
  const releaseStatusOptions = RELEASE_STATUS_ORDER.map(value => ({ value, label: RELEASE_STATUS_LABEL[value] }))
  const projectOptions = [
    { value: '', label: '不属于任何项目' },
    ...(state.config.projects ?? []).map(item => ({ value: item.id, label: item.name })),
  ]
  const envOptions = [
    { value: '', label: '选环境…' },
    ...(state.config?.environments ?? []).map(env => ({ value: env.id, label: env.name })),
  ]
  const candidateOptions = [
    { value: '', label: `挑一张卡挂进来（${candidates.length} 张可选）` },
    ...candidates.map(task => ({ value: task.id, label: `${task.code ? `${task.code} ` : ''}${task.title}` })),
  ]

  const listPane = h('div', { className: 'flex min-w-0 flex-col gap-2' },
          
    h('div', { className: 'flex items-center justify-between gap-2' },
      h('span', { className: HINT }, `${items.length} 个版本`),
      h(Button, { variant: 'secondary', size: 'sm', onClick: createNew }, '＋ 新建版本'),
    ),
    items.length === 0
      ? h(EmptyState, { title: '还没有版本。先建一个版本，再把卡挂上来。' })
      : items.map(item => h('div', {
        key: item.id,
        className: selected === item.id
          ? 'flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl border border-accent-500 bg-background-secondary-default px-3 py-2'
          : 'flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl border border-separator-border bg-background-primary-default px-3 py-2 hover:border-border-button-hover',
        'data-on': selected === item.id ? '1' : '0',
        'data-release-row': item.id,
        onClick: () => void pick(item.id),
      },
        h('div', { className: 'text-body-2-medium text-text-primary' }, `${item.version || item.id} ${item.name}`.trim()),
        h('div', { className: 'flex flex-wrap items-center gap-2' },
          h(Chip, { color: 'soft', 'data-kind': item.status }, RELEASE_STATUS_LABEL[item.status] ?? item.status),
          h(Chip, { color: 'gray' }, `${item.gate.stats.done}/${item.gate.stats.tasks} 卡`),
          item.gate.blockers.length === 0
            ? h(Chip, { color: 'lime' }, '门禁通过')
            : h(Chip, { color: 'rose' }, `${item.gate.blockers.length} 项拦着`),
        ),
      )),
  )

  const detailPane = form === null
    ? h('div', { className: HINT }, '左边选一个版本，或者新建一个。')
    : h('div', { className: 'flex min-w-0 flex-col gap-3 rounded-xl border border-separator-border bg-background-primary-default p-4', 'data-release-detail': '' },
      // 版本 ↔ 需求：卡上挂着哪条需求，这里就列哪条，不用人再维护一遍。
      (release?.requirements ?? []).length === 0 ? null : h('div', { className: ROW },
        h('span', { className: HINT }, `这个版本涉及 ${release.requirements.length} 条需求：`),
        release.requirements.map(req => h(Chip, {
          key: req.id, color: 'soft', title: req.title,
        }, `${req.code || req.id} ${req.title}（${REQ_STATUS_LABEL[req.derived] ?? req.derived}）`)),
      ),
      h('div', { className: 'flex min-w-0 flex-wrap items-start justify-between gap-3' },
        h('div', null,
          h('div', { className: 'text-title-2-semibold text-text-primary' }, `${form.version || '未编号'} ${form.name}`.trim()),
          h('div', { className: HINT }, release === undefined || release === null
            ? '新版本：先填版本号与名字，保存后可以把卡挂进来'
            : `创建于 ${fmtDate(release.createdAt)}${release.releasedAt > 0 ? ` · 发布于 ${fmtDate(release.releasedAt)}` : ''}${release.approveBy !== '' ? ` · 审批人 ${release.approveBy}` : ''}`),
        ),
        h('div', { className: ACTIONS },
          h(Select, {
            className: 'w-28', value: form.status, options: releaseStatusOptions,
            'aria-label': '版本状态',
            onChange: event => setForm({ ...form, status: event.target.value }),
          }),
        ),
      ),
      h('div', { className: `${PANEL} mt-1` },
        h('div', { className: PANEL_HEAD }, '版本信息'),
        h('div', { className: `${PANEL_BODY} grid gap-3 md:grid-cols-2` },
          h('label', { className: FIELD }, h('span', { className: LABEL }, '版本号'),
            h(TextField, { value: form.version, placeholder: 'v1.3.0', disabled: release?.status === 'released', onChange: event => setForm({ ...form, version: event.target.value }) })),
          h('label', { className: FIELD }, h('span', { className: LABEL }, '版本名'),
            h(TextField, { value: form.name, placeholder: '积分抵扣首个版本', onChange: event => setForm({ ...form, name: event.target.value }) })),
          h('label', { className: FIELD }, h('span', { className: LABEL }, '业务项目'),
            h(Select, {
              className: 'w-full', value: form.project, options: projectOptions,
              'aria-label': '业务项目',
              onChange: event => setForm({ ...form, project: event.target.value }),
            })),
          h('label', { className: FIELD }, h('span', { className: LABEL }, '发布负责人'),
            h(TextField, { value: form.owner, onChange: event => setForm({ ...form, owner: event.target.value }) })),
          h('label', { className: FIELD }, h('span', { className: LABEL }, '计划发布时间'),
            h(TextField, {
              value: toDateInput(form.plannedAt),
              onChange: event => setForm({ ...form, plannedAt: fromDateInput(event.target.value) }),
            })),
          h('label', { className: FIELD }, h('span', { className: LABEL }, '发布标签（tag）'),
            h(TextField, { value: form.tagName ?? '', placeholder: 'v1.0.0', onChange: event => setForm({ ...form, tagName: event.target.value }) })),
          h('label', { className: FIELD }, h('span', { className: LABEL }, '对应提交（sha，选填）'),
            h(TextField, { value: form.commitSha ?? '', placeholder: 'a1b2c3d', onChange: event => setForm({ ...form, commitSha: event.target.value }) })),
          h('div', { className: 'flex items-end justify-end gap-2 md:col-span-2' },
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void act('/release/save', { release: form }, '版本已保存') }, '保存'),
            form.id === ''
              ? null
              : h(Button, {
                variant: 'destructive', size: 'sm',
                disabled: busy,
                onClick: async () => {
                  const ok = await confirmDialog('删除这个版本？卡会保留，只是脱离版本。', { title: '删除版本', danger: true, okText: '删除' })
                  if (ok) void act('/release/delete', { id: form.id }, '版本已删除')
                },
              }, '删除')),
        ),
      ),
      release === null || release === undefined
        ? null
        : h('div', { className: `${PANEL} mt-3` },
          h('div', { className: PANEL_HEAD }, '发布门禁',
            h('span', { className: HINT }, '卡全做完、没阻塞、缺陷关闭、用例没有失败，才算能发')),
          h('div', { className: PANEL_BODY },
            h('div', { className: 'grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6' },
              h('div', { className: STATBOX }, h('b', { className: STATVALUE }, String(gate?.stats.done ?? 0)), h('span', { className: LABEL }, '已完成卡')),
              h('div', { className: STATBOX }, h('b', { className: (gate?.stats.open ?? 0) > 0 ? `${STATVALUE} text-text-error-primary` : STATVALUE }, String(gate?.stats.open ?? 0)), h('span', { className: LABEL }, '未完成')),
              h('div', { className: STATBOX }, h('b', { className: (gate?.stats.blocked ?? 0) > 0 ? `${STATVALUE} text-text-error-primary` : STATVALUE }, String(gate?.stats.blocked ?? 0)), h('span', { className: LABEL }, '阻塞')),
              h('div', { className: STATBOX }, h('b', { className: (gate?.stats.bugs ?? 0) > 0 ? `${STATVALUE} text-text-error-primary` : STATVALUE }, String(gate?.stats.bugs ?? 0)), h('span', { className: LABEL }, '未结缺陷')),
              h('div', { className: STATBOX }, h('b', { className: (gate?.stats.failing ?? 0) > 0 ? `${STATVALUE} text-text-error-primary` : STATVALUE }, String(gate?.stats.failing ?? 0)), h('span', { className: LABEL }, '失败用例')),
              h('div', { className: STATBOX }, h('b', { className: STATVALUE }, String(gate?.stats.artifacts ?? 0)), h('span', { className: LABEL }, '交付物')),
            ),
            (gate?.blockers ?? []).map((line, index) => h('div', { key: `b${index}`, className: 'text-caption-1-regular text-text-error-primary' }, `${line}`)),
            (gate?.warnings ?? []).map((line, index) => h('div', { key: `w${index}`, className: HINT }, `${line}`)),
            h('div', { className: 'flex flex-wrap items-center justify-between gap-2' },
              h('div', { className: ACTIONS },
                h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void act('/release/notes', { id: form.id }, '发布说明已生成') }, '生成发布说明'),
                release.status === 'approved'
                  ? h(Button, {
                    variant: 'ghost', size: 'sm', disabled: busy,
                    title: '撤销后要重新审批才能发布',
                    onClick: async () => {
                      if (await confirmDialog(`撤销「${release.version || release.name || '这个版本'}」的审批？撤销后要重新审批才能发布。`, { title: '撤销审批', danger: true, okText: '撤销' })) {
                        void act('/release/approve', { id: form.id, by: '人', action: 'revoke' }, '已撤销审批')
                      }
                    },
                  }, '撤销审批')
                  : h(Button, {
                    variant: 'secondary', size: 'sm',
                    disabled: busy || gate?.approvable !== true,
                    title: gate?.approvable === true ? '把审批结论记到版本上（发布还要求卡 / 用例 / 冒烟都过）' : `先把其它门禁清掉再审批：${(gate?.blockers ?? []).filter(item => item !== '还没有发布审批：先在版本上点「审批通过」并写结论').slice(0, 3).join('；') || '门禁数据还没加载'}`,
                    onClick: () => void act('/release/approve', { id: form.id, by: '人' }, '已审批，可以发布了'),
                  }, '审批通过'),
              ),
              h('div', { className: ACTIONS },
              h(Button, {
                variant: 'primary', size: 'sm',
                disabled: busy || !gate?.ready || release.status === 'released',
                onClick: async () => {
                  const label = release.version || release.name || '这个版本'
                  const ok = await confirmDialog(`发布「${label}」？发布后状态变成已发布，版本号不能再改；这一步会写进部署日志。`, { title: '发布版本', okText: '发布' })
                  if (!ok) return
                  void act('/release/publish', { id: form.id, by: '人' }, '已发布')
                },
              }, release.status === 'released' ? '已发布' : '发布'),
              tipOf('发布准入（预发部署 / 需求签字）没过时也要发：必须写原因，会记进部署日志', h(Button, {
                variant: 'ghost', size: 'sm',
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
                ? h(Button, {
                  variant: 'ghost', size: 'sm', disabled: busy,
                  onClick: async () => {
                    const reason = await promptDialog('回滚原因（要进复盘记录）：', { title: '回滚这个版本', danger: true, okText: '回滚' })
                    if (reason !== null && reason.trim() !== '') void act('/release/rollback', { id: form.id, reason }, '已回滚')
                  },
                }, '回滚')
                : null,
              ),
            ),
            release.rollbackReason === '' ? null : h('div', { className: 'text-caption-1-regular text-text-error-primary' }, `回滚原因：${release.rollbackReason}`),
          ),
        ),
      release === null || release === undefined
        ? null
        : h('div', { className: `${PANEL} mt-3` },
          h('div', { className: PANEL_HEAD }, '发布冒烟清单',
            h('span', { className: HINT }, `${(release.smoke ?? []).filter(item => item.done).length}/${(release.smoke ?? []).length} 项已过 · 发布前逐条点过，门禁才算过`)),
          h('div', { className: PANEL_BODY },
            (release.smoke ?? []).length === 0
              ? h(EmptyState, { title: '还没有冒烟项：把发布前必验的几条写在这里，比如「能登录」「下单支付成功」「首页不报错」。' })
              : null,
            (release.smoke ?? []).map(item => h('div', { key: item.id, className: LISTROW },
              h('label', { className: 'flex min-w-0 flex-1 cursor-pointer items-center gap-2' },
                h(CheckField, { 'aria-label': item.text, checked: item.done === true,
                  onChange: () => void act('/release/smoke', { id: form.id, action: 'toggle', itemId: item.id, done: item.done !== true, by: '人' }, item.done ? '已取消' : '冒烟项已过'),
                }),
                h('span', { className: item.done ? 'text-text-tertiary line-through' : 'text-body-2-regular text-text-primary' }, item.text),
              ),
              item.done && item.by !== '' ? h('span', { className: HINT }, `${item.by} · ${fmtDate(item.at)}`) : null,
              h('div', { className: ACTIONS },
                h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void act('/release/smoke', { id: form.id, action: 'remove', itemId: item.id }, '已删除') }, '×')),
            )),
            h('div', { className: `${ROW} mt-2` },
              h(TextField, {
                style: { flex: 1 }, value: smokeText,
                placeholder: '发布前必须验证什么？', onChange: event => setSmokeText(event.target.value),
              }),
              h(Button, {
                variant: 'secondary', size: 'sm', disabled: busy || smokeText.trim() === '',
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
        : h('div', { className: `${PANEL} mt-3` },
          h('div', { className: PANEL_HEAD }, '审批、灰度与部署记录',
            h('span', { className: HINT }, `审批 ${(release.approvals ?? []).length} 条 · 灰度 ${(release.grayBatches ?? []).length} 批`)),
          h('div', { className: PANEL_BODY },
            (release.approvals ?? []).length === 0
              ? h(EmptyState, { title: '还没有审批记录：点上面的「审批通过」，系统会把谁批的、什么结论记在这里。' })
              : (release.approvals ?? []).map(item => h('div', { key: item.id, className: LISTROW },
                h('div', { className: LISTROW_MAIN },
                  h('div', null, `${item.by} 审批通过`),
                  h('div', { className: HINT }, item.note || '（没写结论）'),
                ),
                h('span', { className: HINT }, fmtDate(item.at)),
              )),
            h('div', { className: 'my-2 border-t border-separator-border' }),
            (release.grayBatches ?? []).length === 0
              ? h('div', { className: HINT }, '没有灰度批次：发布就是一次性全量。先加一批 10% 跑一轮再全量，出事好收。')
              : (release.grayBatches ?? []).map(item => h('div', { key: item.id, className: LISTROW },
                h('div', { className: LISTROW_MAIN },
                  h('div', null, `${item.name} · ${item.percent}%`),
                  h('div', { className: HINT }, `${({ pending: '待开始', running: '灰度中', passed: '已通过', rolled_back: '已回滚' })[item.status] ?? item.status}${item.note === '' ? '' : ` · ${item.note}`}`),
                ),
                h('div', { className: ACTIONS },
                  item.status === 'pending' ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void act('/release/gray', { id: form.id, action: 'start', batchId: item.id, by: '人' }, '已开始灰度') }, '开始') : null,
                  item.status === 'running' ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void act('/release/gray', { id: form.id, action: 'advance', batchId: item.id, by: '人' }, '这一批已通过') }, '通过') : null,
                  item.status === 'running' || item.status === 'passed'
                    ? h(Button, {
                      variant: 'destructive', size: 'sm', disabled: busy,
                      onClick: async () => {
                        const ok = await confirmDialog(`回滚灰度「${item.name}」？会把这个版本整体回滚，之后要重新发布。`, { title: '回滚灰度', danger: true, okText: '回滚' })
                        if (!ok) return
                        void act('/release/gray', { id: form.id, action: 'rollback', batchId: item.id, by: '人', note: '人工回滚' }, '已回滚')
                      },
                    }, '回滚')
                    : null,
                  item.status === 'passed' ? h(Chip, { color: 'lime', 'data-on': '1' }, '已通过') : null,
                  item.status === 'rolled_back' ? h(Chip, { color: 'rose', 'data-sla': 'overdue' }, '已回滚') : null,
                ),
              )),
            h('div', { className: `${ROW} mt-2` },
              h(TextField, {
                style: { flex: 2 }, value: grayName,
                placeholder: '批次名，例如 内测用户', onChange: event => setGrayName(event.target.value),
              }),
              h(TextField, {
                style: { flex: '0 0 88px' }, type: 'number', min: 1, max: 100,
                'aria-label': '灰度批次比例（百分比）',
                value: grayPercent, onChange: event => setGrayPercent(event.target.value),
              }),
              h(Button, {
                variant: 'secondary', size: 'sm', disabled: busy || Number(grayPercent) <= 0,
                onClick: async () => {
                  await act('/release/gray', { id: form.id, action: 'add', name: grayName, percent: Number(grayPercent), by: '人' }, '已加一批灰度')
                  setGrayName('')
                  setGrayPercent('10')
                },
              }, '＋ 加一批'),
            ),
            h('div', { className: 'my-2 border-t border-separator-border' }),
            // 部署环境：这里只留痕，平台不接 CD，也不会去调任何部署脚本。
            h('div', { className: HINT }, '上过哪些环境（只登记，不触发部署）'),
            (release.deploys ?? []).length === 0 ? null : h('div', { className: `${ROW} mt-2` },
              release.deploys.map(item => h(Chip, {
                key: item.id,
                color: item.at === 0 ? 'soft' : 'lime',
                'data-env': item.kind,
                'data-on': item.at === 0 ? '0' : '1',
                title: item.at === 0 ? `还没登记部署到「${item.name}」` : `${item.name}：${fmtDate(item.at)} ${item.action} · ${item.by}`,
              }, item.at === 0 ? `${item.name} —` : `${item.name} ✓`)),
            ),
            h('div', { className: `${ROW} mt-2` },
              h(Select, {
                className: 'w-36', value: deployEnv, options: envOptions,
                'aria-label': '部署环境',
                onChange: event => setDeployEnv(event.target.value),
              }),
              h(TextField, {
                style: { flex: 1 }, value: deployNote,
                placeholder: '备注：谁发的、发了什么（可留空）',
                onChange: event => setDeployNote(event.target.value),
              }),
              h(Button, {
                variant: 'secondary', size: 'sm', disabled: busy || deployEnv === '',
                onClick: async () => {
                  await act('/release/deploy', { id: form.id, env: deployEnv, note: deployNote, by: '人' }, '已登记部署（没有触发任何部署）')
                  setDeployNote('')
                },
              }, '登记部署'),
            ),
            h('div', { className: `${HINT} mt-3` }, '部署与灰度记录（最近 8 条）'),
            (() => {
              const GRAY = { pending: '待开始', running: '灰度中', passed: '已通过', rolled_back: '已回滚' }
              const rows = [
                ...(release.deployLog ?? []).map(item => ({ at: item.at, kind: 'deploy', by: item.by, text: `${item.action}${item.env === '' ? '' : ` · ${(state.config?.environments ?? []).find(env => env.id === item.env)?.name ?? item.env}`}`, note: item.note })),
                ...(release.grayBatches ?? []).map(item => ({ at: item.at ?? item.createdAt ?? 0, kind: 'gray', by: item.by ?? '人', text: `灰度 ${item.name} ${item.percent}%`, note: GRAY[item.status] ?? item.status })),
              ].filter(entry => entry.at).sort((a, b) => a.at - b.at).slice(-8).reverse()
              if (rows.length === 0) return h(EmptyState, { title: '还没有部署或灰度记录。' })
              return rows.map(entry => h('div', { key: `${entry.at}-${entry.kind}-${entry.text}`, className: HINT },
                h(Chip, { color: 'soft', className: 'me-2' }, entry.kind === 'gray' ? '灰度' : '部署'),
                `${fmtDate(entry.at)} · ${entry.text} · ${entry.by}${entry.note === '' || entry.note === undefined ? '' : `：${entry.note}`}`))
            })(),
          ),
        ),
      release === null || release === undefined
        ? null
        : h('div', { className: `${PANEL} mt-3` },
          h('div', { className: PANEL_HEAD }, '这个版本里的卡', h('span', { className: HINT }, `${tasks.length} 张`)),
          h('div', { className: PANEL_BODY },
            tasks.length === 0
              ? h(EmptyState, { title: '还没有卡。从下面挑，或者在卡片详情里选「所属版本」。' })
              : tasks.map(task => h('div', { key: task.id, className: LISTROW },
                h('div', { className: LISTROW_MAIN },
                  h('div', null, `${task.code ? `${task.code} ` : ''}${task.title}`),
                  h('div', { className: HINT }, `${(state.statuses ?? []).find(entry => entry.id === task.status)?.label ?? task.status}${task.blocked !== null && task.blocked !== undefined ? ' · 阻塞' : ''}${task.type === 'bug' ? ' · 缺陷' : ''}`),
                ),
                h('div', { className: ACTIONS },
                  h(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenTask(task.id) }, '打开'),
                  h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void act('/release/link', { id: form.id, taskId: task.id, action: 'remove' }, '已从版本移除') }, '移除'),
                ),
              )),
            h('div', { className: `${ROW} mt-2` },
              h(Select, {
                className: 'flex-1', value: picker, options: candidateOptions,
                'aria-label': '挑一张卡挂进来',
                onChange: event => setPicker(event.target.value),
              }),
              h(Button, {
                variant: 'secondary', size: 'sm', disabled: busy || picker === '',
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
        : h('div', { className: `${PANEL} mt-3` },
          h('div', { className: PANEL_HEAD }, '发布说明',
            h(Button, {
              variant: 'ghost', size: 'sm', disabled: busy,
              onClick: () => void navigator.clipboard?.writeText(notes).then(() => setNotice('发布说明已复制'), () => undefined),
            }, '复制')),
          h('div', { className: PANEL_BODY },
            h(MdField, {
              rows: 12, value: notes,
              placeholder: '点「生成发布说明」按类型自动汇总；之后可以在这里手动补充',
              onChange: event => setNotes(event.target.value),
              onBlur: () => { if (notes !== (release.notes ?? '')) void act('/release/save', { release: { ...form, notes } }, '发布说明已保存') },
            })),
        ),
      error === null ? null : h('div', { className: 'mt-2 text-caption-1-regular text-text-error-primary' }, error),
      notice === '' ? null : h('div', { className: HINT, style: { marginTop: 8 } }, notice),
    )

  return h('div', { className: PAGE, 'data-releases-page': '' },
    h('div', { className: 'grid grid-cols-1 items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]' }, listPane, detailPane),
  )
}
