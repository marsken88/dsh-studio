/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

import { fmtTime, fmtDate } from '../format.js'
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell } from '../../components/base/table/table'
import { client } from '../context.js'
import { REQ_STATUS_LABEL, REQ_STATUS_ORDER, DOC_KIND_LABEL, DOC_KIND_ORDER, DOC_STATUS_LABEL } from '../labels.js'
import { caseSummaryOf, checkSummaryOf } from '../roster.js'
import { diffLines, diffSummary } from '../diff.js'
import { Button, Select, Chip } from '../../boardui/index'
import { EmptyState } from '../../boardui/empty-state'
import { ProgressTrack } from '../../components/base/progress/progress'

/* 「先聊清楚」：用户还没想清楚时，用 5 个问题把需求聊成一份 PRD 草稿；不调模型、纯本地合成。 */
const INTAKE_STEPS = [
  { key: 'title', question: '这条需求一句话是什么？', hint: '例：管理后台登录失败要锁定账号，防止暴力破解' },
  { key: 'who', question: '谁在用？他们现在是怎么做的？', hint: '例：运营同学现在只能反复试密码，锁没锁只能靠猜' },
  { key: 'goal', question: '你希望他们能做什么？做到什么程度？', hint: '例：连续错 5 次锁 10 分钟，锁定期间正确密码也拒绝' },
  { key: 'scope', question: '这次明确不做什么？', hint: '例：不做图形验证码，不做异地登录提醒' },
  { key: 'accept', question: '怎么算完成？写一条能验收的标准。', hint: '例：第 6 次请求返回 423，锁定期内正确密码仍 423' },
]
const composeIntake = answers => [
  '## 背景',
  String(answers.who ?? '').trim() || '（待补充）',
  '',
  '## 目标',
  String(answers.goal ?? '').trim() || '（待补充）',
  '',
  '## 范围与不做什么',
  String(answers.scope ?? '').trim() || '（待补充）',
  '',
  '## 验收',
  String(answers.accept ?? '').trim() || '（待补充）',
  '',
  '> 本稿由「先聊清楚」的 5 个回答整理而成，保存后可在需求详情里继续补功能点、文档与验收条件。',
].join('\n')

/* 整页 BoardUI：面板 / 表单 / 列表 / 徽标 / 动作全部换成 token + Tailwind（4px 档位）。
   Markdown 正文不是组件：renderMarkdown 的产物挂语义类 md-content，排版规则（标题/列表/表格/代码）
   写在 client.src.js 的 CSS 段里——BoardUI 没有等价的富文本作用域，删了正文就没样式了。 */
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
const CODE = 'inline-flex items-center rounded-md border border-separator-border bg-background-secondary-default px-1 font-mono text-caption-1-regular text-text-secondary'
const LINK = 'text-caption-1-medium text-accent-600 hover:underline'
const SECTION = 'mt-4 flex flex-wrap items-center gap-2 text-caption-1-medium text-text-tertiary'
const SECTION_BODY = 'flex min-w-0 flex-col gap-2'
const MOUNT = 'rounded-xl border border-separator-border bg-background-secondary-default px-3 py-3'

export     function IntakePage({ state, onChanged, mode }) {
  const { h, React, api, toast, currentUser, confirmDialog, promptDialog, renderMarkdown, TextField, TextAreaField, SelectField, CheckField, MdField, SideDrawer } = client()
      const business = (state.requirements ?? []).filter(item => item.source === 'business')
      const [note, setNote] = React.useState('')
      const [result, setResult] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [src, setSrc] = React.useState('business')
      const val = id => (document.getElementById(id)?.value ?? '').trim()
      const submit = async () => {
        setBusy(true)
        try {
          const reporter = val('ip-name')
        const extra = { project: val('ip-project'), iteration: val('ip-iteration'), priority: val('ip-priority') || 'normal', links: { prd: val('ip-prd'), proto: val('ip-proto'), acceptance: val('ip-acceptance') } }
          const out = reporter !== ''
            ? await api('/intake/requirement', Object.assign({ title: val('ip-title'), description: val('ip-desc'), requester: reporter, dept: val('ip-dept'), contact: val('ip-contact') }, extra))
            : await api('/requirement/save', { requirement: Object.assign({ title: val('ip-title'), description: val('ip-desc'), source: 'internal', status: 'draft' }, extra) })
          setNote('已提交：' + (out.code ?? ''))
          onChanged()
        } catch (error) { setNote(error.message ?? String(error)) }
        setBusy(false)
      }
      const query = async () => {
        try {
          const out = await api('/intake/query', { code: val('ip-qcode'), contact: val('ip-qcc') })
          setResult([out.code, out.title || '', out.statusLabel || '', '待确认 ' + (out.openQuestions ?? 0), '卡片 ' + (out.doneCards ?? 0) + '/' + (out.cards ?? 0)].filter(part => part !== '').join('｜'))
        } catch (error) { setResult(error.message ?? String(error)) }
      }
      const convert = async id => {
        try { await api('/requirement/request-prd', { id, by: currentUser() }); toast('已转产品：待评审'); onChanged() }
        catch (error) { toast(error.message ?? String(error), 'error') }
      }
      const panel = (title, hint, body) => h('div', { className: PANEL, 'data-panel': title === '业务提单' ? 'form' : (title.startsWith('业务提单 ') ? 'list' : 'status') },
        h('div', { className: PANEL_HEAD },
          h('div', { className: 'text-body-2-medium text-text-primary' }, title),
          h('span', { className: HINT }, hint),
        ),
        h('div', { className: PANEL_BODY }, body),
      )
      return h('div', { className: PAGE, 'data-mode': mode ?? '', 'data-intake-page': '' },
        h('div', { className: 'grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]' },
          panel('业务提单', '提交后进入「草稿」，等产品补 PRD', [
            h('div', { className: FIELD }, h('div', { className: LABEL }, '标题'), h(TextField, { id: 'ip-title', placeholder: '一句话说清要做什么' })),
            h('div', { className: FIELD }, h('div', { className: LABEL }, '描述（至少 10 字）'), h(TextAreaField, { id: 'ip-desc', rows: 4, placeholder: '现状、期望、影响范围' })),
h('div', { className: 'grid grid-cols-2 gap-3' },
h('div', { className: FIELD }, h('div', { className: LABEL }, '项目'), h(SelectField, { id: 'ip-project', 'aria-label': '项目' },
                h('option', { value: '' }, '不指定（先进需求池）'),
                ((state.config && state.config.projects) || state.projects || []).map(item => h('option', { key: item.id, value: item.id }, item.name)))),
h('div', { className: FIELD }, h('div', { className: LABEL }, '迭代'), h(TextField, { id: 'ip-iteration', placeholder: '如 2026-11' })),
),
h('div', { className: FIELD }, h('div', { className: LABEL }, '优先级'), h(SelectField, { id: 'ip-priority', 'aria-label': '优先级' },
                h('option', { value: 'normal' }, '普通'),
                h('option', { value: 'urgent' }, '紧急'),
                h('option', { value: 'relaxed' }, '不急'))),
h('div', { className: FIELD }, h('div', { className: LABEL }, 'PRD 链接'), h(TextField, { id: 'ip-prd', placeholder: 'https://…' })),
h('div', { className: FIELD }, h('div', { className: LABEL }, '原型链接'), h(TextField, { id: 'ip-proto', placeholder: 'https://…' })),
h('div', { className: FIELD }, h('div', { className: LABEL }, '验收标准链接'), h(TextField, { id: 'ip-acceptance', placeholder: 'https://…' })),
            h('div', { className: ROW },
              h('div', { className: FIELD, style: { flex: '1 1 140px' } }, h('div', { className: LABEL }, '姓名'), h(TextField, { id: 'ip-name', 'aria-label': '联系人姓名' })),
              h('div', { className: FIELD, style: { flex: '1 1 140px' } }, h('div', { className: LABEL }, '部门'), h(TextField, { id: 'ip-dept', 'aria-label': '联系部门' })),
              h('div', { className: FIELD, style: { flex: '1 1 140px' } }, h('div', { className: LABEL }, '联系方式'), h(TextField, { id: 'ip-contact', 'aria-label': '联系人联系方式' })),
            ),
            h('div', { className: ROW },
              h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: submit }, busy ? '提交中…' : '提交需求'),
              note === '' ? null : h('span', { style: { fontSize: 12, color: 'var(--muted-foreground)' } }, note),
            ),
          ]),
          panel('查进度', '编号 + 联系方式后四位', [
            h('div', { className: FIELD }, h('div', { className: LABEL }, '需求编号'), h(TextField, { id: 'ip-qcode', placeholder: 'REQ-2026-001' })),
            h('div', { className: FIELD }, h('div', { className: LABEL }, '联系方式后四位'), h(TextField, { id: 'ip-qcc', 'aria-label': '联系方式后四位' })),
            h('div', null, h(Button, { variant: 'secondary', size: 'sm', onClick: query }, '查询')),
            result === '' ? null : h('div', { className: MOUNT }, result),
          ]),
          h('div', { className: 'xl:col-span-2' },
            panel('业务提单 ' + business.length + ' 条', '转产品 = 送进待评审；产品补 PRD 后才能拆卡', [
              business.length === 0
                ? h(EmptyState, { title: '还没有业务提单。' })
                : business.map(item => h('div', { key: item.id, className: 'flex min-w-0 items-center gap-3 rounded-lg border border-separator-border bg-background-primary-default px-3 py-2' },
                  h('div', { className: 'flex min-w-0 flex-1 flex-col gap-0.5' },
                    h('div', { className: 'truncate text-body-2-medium text-text-primary' }, (item.code || '未编号') + '　' + item.title),
                    h('div', { className: HINT }, (REQ_STATUS_LABEL[item.status] ?? item.status) + ' · ' + (item.requester?.name ?? '') + (item.requester?.dept ? '（' + item.requester.dept + '）' : '')),
                  ),
                  h(Button, { variant: 'ghost', size: 'sm', onClick: () => convert(item.id) }, '转产品'),
                )),
            ]),
          ),
        ),
      )
    }

export     function RequirementsPage({ state, onOpenTask, onChanged, createSignal, focusReq }) {
  const { h, React, api, toast, currentUser, confirmDialog, promptDialog, renderMarkdown, TextField, TextAreaField, SelectField, CheckField, MdField, SideDrawer } = client()
      const requirements = state.requirements ?? []
      const projects = state.config.projects ?? []
      const statusOptions = REQ_STATUS_ORDER.map(id => ({ value: id, label: REQ_STATUS_LABEL[id] }))
      const projectOptions = [
        { value: '', label: '不指定' },
        ...projects.map(project => ({ value: project.id, label: project.name })),
      ]
      const docKindOptions = DOC_KIND_ORDER.map(id => ({ value: id, label: DOC_KIND_LABEL[id] }))
      const pointPriorityOptions = [{ value: 'urgent', label: '紧急' }, { value: 'normal', label: '普通' }, { value: 'relaxed', label: '可缓' }]
      const pointStatusOptions = [{ value: 'draft', label: '草稿' }, { value: 'ready', label: '就绪' }, { value: 'done', label: '已完成' }]
      const [selected, setSelected] = React.useState(requirements.length > 0 ? requirements[0].id : null)
      /* 来源筛选与搜索：以前「来源」按钮只写 localStorage + dispatchEvent('resize')，
         全站没有 resize 监听，点了标签变、列表不变（死交互）。改成真 state。 */
      const [reqSource, setReqSource] = React.useState(() => {
        try {
          const saved = window.localStorage.getItem('dsh-studio:reqsrc') ?? 'all'
          return ['all', 'business', 'internal'].includes(saved) ? saved : 'all'
        } catch { return 'all' }
      })
      const [reqQuery, setReqQuery] = React.useState('')
      /* 需求级沟通（issue #115 的界面那一半）：评论的草稿与提交态。 */
      const [commentDraft, setCommentDraft] = React.useState('')
      const [commentBusy, setCommentBusy] = React.useState(false)
      /* 排序沿用老口径：按 RICE 分从高到低（reqsort 从来没有写入点，别再假装可切）。 */
      const reqQueryText = reqQuery.trim().toLowerCase()
      const visibleRequirements = requirements
        .filter(item => reqSource === 'all' || (item.source === 'business' ? 'business' : 'internal') === reqSource)
        .filter(item => reqQueryText === '' || [item.code, item.title, item.owner, item.requester?.name]
          .filter(Boolean).join(' ').toLowerCase().includes(reqQueryText))
        .slice()
        .sort((left, right) => (right.pool?.score ?? 0) - (left.pool?.score ?? 0))
      // 从顶部「＋ 新建 → 新建需求」进来时，展开新建表单（form 为 null 时不显示面板）。
      const openNew = () => {
        setForm({ title: '', description: '', project: '', iteration: '', owner: '', priority: 'normal', status: 'draft', links: {} })
        setIntake(null)
        setError(null)
      }
      React.useEffect(() => { if (Number(createSignal) > 0) openNew() }, [createSignal])
      // 从全局搜索跳过来时，直接选中那一条需求。
      React.useEffect(() => { if (focusReq && focusReq.id) setSelected(focusReq.id) }, [focusReq])
      const [form, setForm] = React.useState(null)
      /* 对话澄清：null = 直接填写；对象 = 正在一步步聊。 */
      const [intake, setIntake] = React.useState(null)
      /* 对话生成的草稿要建 PRD 文档：用 ref 记一下，避免保存按钮拿到旧闭包里的 form。 */
      const fromChatRef = React.useRef(false)
      const [error, setError] = React.useState(null)
      /* 需求详情分区：概览 / 沟通 / 任务与验收 / 交付物。只切显示，数据仍整页加载。 */
      const [reqPane, setReqPane] = React.useState('overview')
      const [busy, setBusy] = React.useState(false)
      const [docForm, setDocForm] = React.useState(null)
      const [docNote, setDocNote] = React.useState(null)
      const [docReader, setDocReader] = React.useState(null)
      const [baseDiff, setBaseDiff] = React.useState(null)
      const [docAll, setDocAll] = React.useState(null)
      const [docBusy, setDocBusy] = React.useState(false)
      const [driveNote, setDriveNote] = React.useState(null)
      const [driveBusy, setDriveBusy] = React.useState(false)
      // ---- 功能点与可追溯矩阵：需求结构化之后，能查到「每条验收标准被谁做、被哪条用例验」
      const [matrix, setMatrix] = React.useState(null)
      const [matrixNote, setMatrixNote] = React.useState(null)
      // 矩阵是整条需求的全部功能点，一屏十几行时先筛再编辑：按编号/标题/验收条件搜，或只看未覆盖。
      const [matrixQuery, setMatrixQuery] = React.useState('')
      const [matrixOnlyOpen, setMatrixOnlyOpen] = React.useState(false)
      const [pointForm, setPointForm] = React.useState(null)
      /* 需求矩阵里功能点描述是一整段 markdown，全渲染会把表格行撑到半屏高（一屏只看得下两三行）。
         默认只显示两行摘要，点「全文」再展开 —— 表格回到「一眼扫完」的用途。 */
      const [openPointIds, setOpenPointIds] = React.useState(() => new Set())
      /* 矩阵编辑：勾选多个功能点批量覆盖验收条件；编辑表单在表格上方就地展开（不再在页面底部）。 */
      const [selectedPointIds, setSelectedPointIds] = React.useState(() => new Set())
      const [bulkAcceptance, setBulkAcceptance] = React.useState(null)
      const [pointFormTick, setPointFormTick] = React.useState(0)
      const pointFormRef = React.useRef(null)
      // ---- 需求准出与验收签字
      const [reqSign, setReqSign] = React.useState('')
      const [reqNote, setReqNote] = React.useState(null)
      // ---- 依赖与排序
      const [reqOrder, setReqOrder] = React.useState('0')
      const [reqDeps, setReqDeps] = React.useState([])
      const [depNote, setDepNote] = React.useState(null)
      // ---- 影响面：这条需求改动之后，哪些卡和用例要重看
      const [impact, setImpact] = React.useState(null)
      const [impactBusy, setImpactBusy] = React.useState(false)
      const loadImpact = async () => {
        if (currentForDeps === null) return
        setImpactBusy(true)
        try {
          const json = await api('/requirement/impact', { id: currentForDeps.id })
          setImpact({ summary: json.summary, cards: json.cards ?? [], cases: json.cases ?? [] })
        } catch (cause) { setDepNote(cause instanceof Error ? cause.message : String(cause)) } finally { setImpactBusy(false) }
      }

      const currentForDeps = requirements.find(item => item.id === selected) ?? null
      React.useEffect(() => {
        setReqOrder(String(currentForDeps?.order ?? 0))
        setReqDeps(Array.isArray(currentForDeps?.dependsOn) ? currentForDeps.dependsOn : [])
        setDepNote(null)
      }, [selected, currentForDeps?.updatedAt])

      const saveDeps = async () => {
        if (currentForDeps === null) return
        try {
          /* 只发这三个字段。以前是把打开页面时的整份副本（标题/正文/负责人/链接…）
             一起回写，别人这期间改了标题或加了功能点，就会被这次保存静默覆盖/丢掉。 */
          await api('/requirement/save', {
            requirement: {
              id: currentForDeps.id,
              order: Number(reqOrder) || 0,
              dependsOn: reqDeps,
            },
          })
          setDepNote('已保存：排序与依赖'); toast('排序与依赖已保存')
          if (onChanged !== undefined) onChanged()
        } catch (cause) { setDepNote(cause instanceof Error ? cause.message : String(cause)) }
      }

      const signRequirement = async (action) => {
        if (current === null) return
        const note = String(reqSign ?? '').trim()
        if (action === 'sign' && note === '') { setReqNote('签字要写一句结论：交付了什么、遗留什么'); return }
        try {
          await api('/requirement/signoff', { id: current.id, action, note, by: currentUser() })
          setReqNote(action === 'sign' ? '已签字' : '已取消签字'); toast(action === 'sign' ? '需求已签字' : '已取消需求签字')
          setReqSign('')
          if (onChanged !== undefined) onChanged()
        } catch (err) {
          setReqNote(err.message)
        }
      }

      const loadMatrix = React.useCallback(async (id) => {
        if (id === undefined || id === null || id === '') { setMatrix(null); return }
        try {
          const json = await api('/requirement/matrix', { id })
          setMatrix(json.matrix)
        } catch (err) {
          setMatrixNote(err.message)
        }
      }, [])

      const savePoints = async (points) => {
        if (current === null) return
        try {
          await api('/requirement/save', { requirement: { ...current, links: current.links ?? {}, points } })
          await loadMatrix(current.id)
          setMatrixNote('功能点已保存')
          setPointForm(null)
        } catch (err) {
          setMatrixNote(err.message)
        }
      }

      const blankPoint = () => ({ title: '', description: '', priority: 'normal', status: 'draft', acceptance: [] })

      const savePoint = async () => {
        if (pointForm === null || current === null) return
        if (String(pointForm.title ?? '').trim() === '') { setMatrixNote('功能点要有标题'); return }
        const acceptance = String(pointForm.acceptanceText ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
        const entry = {
          id: pointForm.id ?? `p${(current.points ?? []).length + 1}`,
          title: pointForm.title,
          description: pointForm.description ?? '',
          priority: pointForm.priority ?? 'normal',
          status: pointForm.status ?? 'draft',
          acceptance: acceptance.map((line, index) => ({ id: `a${index + 1}`, text: line, done: false })),
        }
        const existing = (current.points ?? []).filter(item => item.id !== entry.id)
        await savePoints([...existing, entry])
      }

      const openPointForm = point => {
        setPointForm(point)
        setPointFormTick(tick => tick + 1)
      }

      /* 表格上方就地展开：点「编辑」后滚动过去，不用再翻到页面底部找表单。 */
      React.useEffect(() => {
        if (pointForm === null) return
        const node = pointFormRef.current
        if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, [pointFormTick])

      /* 批量覆盖验收条件：一行一条，替换所选功能点的全部条件。
         id 按位置复用（前 N 条保留原 id），尽量少打断已挂条件的用例；删掉的条件仍会变成「未挂条件」。 */
      const applyBulkAcceptance = async () => {
        if (current === null || bulkAcceptance === null) return
        const texts = String(bulkAcceptance.text ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
        if (texts.length === 0) { setMatrixNote('批量验收条件至少要写一条'); return }
        const ids = new Set(selectedPointIds)
        if (ids.size === 0) { setMatrixNote('先勾选要改的功能点'); return }
        if (!(await confirmDialog(`用这 ${texts.length} 条验收条件替换所选 ${ids.size} 个功能点的全部条件？已挂在这些条件下的用例会变成「未挂条件」。`, { title: '批量设置验收条件', danger: true, okText: '替换' }))) return
        const next = (current.points ?? []).map(point => {
          if (!ids.has(point.id)) return point
          const oldIds = (point.acceptance ?? []).map(item => item.id)
          return { ...point, acceptance: texts.map((text, index) => ({ id: oldIds[index] ?? `a${index + 1}`, text, done: false })) }
        })
        await savePoints(next)
        setSelectedPointIds(new Set())
        setBulkAcceptance(null)
      }

      const removePoint = async (pointId) => {
        if (current === null) return
        if (!(await confirmDialog('删除这个功能点？挂在上面的卡会变成「未归功能点」。', { title: '删除功能点', danger: true, okText: '删除' }))) return
        await savePoints((current.points ?? []).filter(item => item.id !== pointId))
      }

      const assignLoose = async (taskId, pointId) => {
        try {
          await api('/task/update', { id: taskId, pointId })
          if (current !== null) await loadMatrix(current.id)
        } catch (err) {
          setMatrixNote(err.message)
        }
      }

      const current = requirements.find(item => item.id === selected) ?? null
      // 换一条需求就把批量选择清掉，避免把上一条需求的功能点 id 带过来。
      React.useEffect(() => { setSelectedPointIds(new Set()); setBulkAcceptance(null) }, [selected])
      const tasksOf = id => state.tasks.filter(task => task.requirementId === id)
      const statusLabel = id => (state.statuses.find(column => column.id === id)?.label ?? id)

      React.useEffect(() => {
        setMatrix(null)
        setMatrixNote(null)
        if (current !== null) void loadMatrix(current.id)
      }, [current === null ? '' : current.id, loadMatrix])

      const startIntake = () => setIntake({ step: 0, answers: {}, input: '', done: false })
      const submitIntake = () => {
        if (intake === null) return
        const value = String(intake.input ?? '').trim()
        if (value === '') return
        const answers = { ...intake.answers, [INTAKE_STEPS[intake.step].key]: value }
        if (intake.step >= INTAKE_STEPS.length - 1) setIntake({ ...intake, answers, input: '', done: true })
        else setIntake({ ...intake, answers, input: '', step: intake.step + 1 })
      }
      const finishIntake = () => {
        if (intake === null) return
        const answers = intake.answers
        fromChatRef.current = true
        setForm({
          title: String(answers.title ?? '').trim(),
          description: composeIntake(answers),
          project: '', iteration: '', owner: '', priority: 'normal', status: 'draft',
          links: {}, fromChat: true,
        })
        setIntake(null)
      }
      const renderIntake = () => {
        if (intake === null) return null
        const step = INTAKE_STEPS[intake.step]
        const done = intake.done === true
        const transcript = []
        for (let i = 0; i < intake.step; i++) {
          transcript.push(h('div', { key: 'q' + i, className: 'rounded-xl bg-background-secondary-default px-3 py-2 text-body-2-regular text-text-primary' }, INTAKE_STEPS[i].question))
          transcript.push(h('div', { key: 'a' + i, className: 'self-end rounded-xl bg-accent-600 px-3 py-2 text-body-2-regular text-text-white' }, intake.answers[INTAKE_STEPS[i].key]))
        }
        transcript.push(h('div', { key: 'q-now', className: 'rounded-xl bg-background-secondary-default px-3 py-2 text-body-2-regular text-text-primary' }, step.question))
        transcript.push(h('div', { key: 'hint', className: HINT }, step.hint))
        if (done) {
          transcript.push(h('div', { key: 'done', className: 'rounded-xl bg-status-lime-background px-3 py-2 text-body-2-regular text-text-primary' }, '收到，我按这些回答整理成需求文档草稿；保存后还能改。'))
          transcript.push(h('div', { key: 'preview', className: 'md-content rounded-xl border border-separator-border p-3 text-body-2-regular text-text-primary' }, renderMarkdown(composeIntake(intake.answers))))
        }
        return h('div', { 'data-intake-ui': '', className: 'flex min-w-0 flex-col gap-2' },
          h('div', { className: HINT }, done ? '回答完了，检查一下草稿' : `第 ${intake.step + 1} / ${INTAKE_STEPS.length} 个问题`),
          h('div', { className: 'flex min-w-0 flex-col gap-2', 'data-intake-transcript': '' }, transcript),
          done
            ? h('div', { className: 'flex flex-wrap items-center gap-2' },
              h(Button, { variant: 'secondary', size: 'sm', onClick: () => setIntake({ ...intake, done: false, step: INTAKE_STEPS.length - 1 }) }, '改最后一条'),
              h(Button, { variant: 'primary', size: 'sm', onClick: finishIntake }, '生成文档并继续编辑'))
            : h('div', { className: 'flex min-w-0 flex-col gap-2' },
              h(TextAreaField, {
                rows: 3, value: intake.input, 'aria-label': '回答当前问题',
                placeholder: '用自己的话写，想到多少写多少',
                onChange: event => setIntake({ ...intake, input: event.target.value }),
                onKeyDown: event => {
                  if ((event.metaKey || event.ctrlKey) && (event.key === 'Enter' || event.key === 'NumpadEnter')) {
                    event.preventDefault(); submitIntake()
                  }
                },
              }),
              h('div', { className: 'flex flex-wrap items-center gap-2' },
                intake.step > 0 ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => setIntake({ ...intake, step: intake.step - 1, input: intake.answers[INTAKE_STEPS[intake.step - 1].key] ?? '' }) }, '上一条') : null,
                h(Button, { variant: 'primary', size: 'sm', disabled: String(intake.input ?? '').trim() === '', onClick: submitIntake }, intake.step >= INTAKE_STEPS.length - 1 ? '看草稿' : '下一条'))))
      }
      const save = async () => {
        if (form === null) return
        if (String(form.title ?? '').trim() === '') { setError('需求标题不能为空'); return }
        setBusy(true)
        try {
          /* 先记下「这是新建 + 来自对话」：保存后再拿响应里的 created 判断，
             出现过字段不在回包里导致 PRD 草稿没建的情况。 */
          const isNew = form.id === undefined || form.id === null || form.id === ''
          const fromChat = fromChatRef.current === true || form.fromChat === true || String(form.description ?? '').includes('本稿由「先聊清楚」')
          const payload = await api('/requirement/save', {
            intake: fromChat,
            requirement: {
              id: form.id,
              title: form.title,
              description: form.description,
              project: form.project,
              owner: form.owner,
              domain: form.domain ?? '',
              priority: form.priority,
              status: form.status,
              links: { prd: form.prd, proto: form.proto, acceptance: form.acceptance },
              discovery: form.discovery ?? { server: '', auth: '', boundary: '' },
            },
          })
          setSelected(payload.requirement.id)
          let docNote = ''
          if (isNew && fromChat) {
            try {
              await api('/requirement/doc', {
                id: payload.requirement.id, action: 'add', by: '需求澄清',
                doc: { kind: 'prd', title: `${form.title} PRD`, version: 'v1.0', content: form.description },
              })
            } catch (cause) { docNote = '；PRD 草稿没建成：' + (cause instanceof Error ? cause.message : String(cause)) }
          }
          fromChatRef.current = false
          setForm(null)
          setError(null)
          toast((payload.created === true ? '需求已创建' : '需求已保存') + docNote)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }

      const setStatus = async (status) => {
        if (current === null) return
        try {
          await api('/requirement/save', { requirement: { ...current, links: current.links ?? {}, status } })
          toast('需求状态已更新')
        } catch (err) {
          setError(err.message)
        }
      }

      const remove = async (id) => {
        if (!(await confirmDialog('删除这条需求？它下面的卡会保留，只是不再挂需求。', { title: '删除需求', danger: true, okText: '删除' }))) return
        try {
          await api('/requirement/delete', { id })
          setSelected(null)
        } catch (err) {
          setError(err.message)
        }
      }

      // ---- 评审：提交评审 → 通过 / 打回（打回必须写意见，需求退回草稿）
      const REVIEW_LABEL = { pending: '待评审', approved: '评审通过', changes_requested: '评审打回' }
      const [reviewBusy, setReviewBusy] = React.useState(false)
      const [reviewNote, setReviewNote] = React.useState(null)
      const reviewRequirement = async (decision, note) => {
        if (current === null) return
        setReviewBusy(true)
        setReviewNote(null)
        try {
          const json = await api('/requirement/review', { id: current.id, decision, note: note ?? '', by: currentUser(), operator: currentUser() })
          setReviewNote(`已${decision === 'approve' ? '通过' : decision === 'reject' ? '打回' : '提交'}评审：${REVIEW_LABEL[json.review?.status] ?? ''}`)
          if (typeof onChanged === 'function') onChanged()
        } catch (err) {
          setReviewNote(err.message)
        } finally {
          setReviewBusy(false)
        }
      }
      const rejectReview = async () => {
        const note = await promptDialog('打回要给意见（会记在评审记录里）：', { title: '评审打回', danger: true, okText: '打回', placeholder: '写清楚哪里不满足，之后要据此改' })
        if (note === null) return
        if (String(note).trim() === '') { setReviewNote('打回必须写意见'); return }
        void reviewRequirement('reject', String(note).trim().slice(0, 600))
      }

      // ---- 按未覆盖的功能点批量拆卡：一条功能点一张卡，挂好 pointId，直接出现在看板
      const [splitBusy, setSplitBusy] = React.useState(false)
      const [splitNote, setSplitNote] = React.useState(null)
      const splitPoints = async () => {
        if (current === null) return
        setSplitBusy(true)
        setSplitNote(null)
        try {
          const json = await api('/requirement/split', { id: current.id })
          const created = json.created ?? []
          const warnings = Array.isArray(json.warnings) ? json.warnings : []
          setSplitNote((created.length === 0
            ? '没有可拆的功能点：要么都覆盖了，要么还没加功能点。'
            : `已建 ${created.length} 张卡：${created.map(item => item.code || item.id).join('、')}`) + (warnings.length === 0 ? '' : ' · 注意：' + warnings.join('；')))
          if (typeof onChanged === 'function') onChanged()
        } catch (err) {
          setSplitNote(err.message)
        } finally {
          setSplitBusy(false)
        }
      }

      // ---- 文档与基线：链路上「研发拿的是哪一版」的唯一答案
      const blankDoc = () => ({ kind: 'prd', title: '', url: current?.links?.prd ?? '', version: 'v1.0', content: '', status: 'draft' })
      const openDoc = async (docId) => {
        setDocNote(null)
        if (docId === null) { setDocForm(blankDoc()); return }
        try {
          const json = await api('/requirement/get', { id: current.id })
          const doc = (json.requirement?.docs ?? []).find(item => item.id === docId)
          setDocForm(doc === undefined ? blankDoc() : { ...doc })
        } catch (err) {
          setError(err.message)
        }
      }
      const readDoc = async (docId) => {
      if (docReader !== null && docReader.id === docId) { setDocReader(null); return }
      setDocReader({ id: docId, content: '', busy: true })
      try {
        const json = await api('/requirement/get', { id: current.id })
        const doc = (json.requirement?.docs ?? []).find(item => item.id === docId)
        setDocReader({ id: docId, content: String(doc?.content ?? ''), busy: false })
      } catch (err) {
        setError(err.message)
        setDocReader(null)
      }
    }
    // 基线 vs 当前文档：只读对比，不改任何数据。
    const compareBaseline = async () => {
      if (baseDiff !== null) { setBaseDiff(null); return }
      try {
        const json = await api('/requirement/get', { id: current.id })
        const req = json.requirement ?? {}
        const baseline = req.baseline ?? null
        const docs = req.docs ?? []
        // 「当前文档」= 最新的一篇 PRD（基线那份本身不在比较之列，否则永远没差异）
    const newest = [...docs].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    const doc = newest.find(item => item.kind === 'prd') ?? newest[0] ?? null
        if (baseline === null) { setBaseDiff(null); setError('这条需求还没有基线，先挑一份文档「设为基线」'); return }
        if (doc === null) { setBaseDiff(null); setError('这条需求还没有文档可以对比'); return }
        const rows = diffLines(baseline.content ?? '', doc.content ?? '')
        setBaseDiff({ rows, summary: diffSummary(rows), version: baseline.version, docTitle: doc.title })
      } catch (cause) {
        setBaseDiff(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    const expandAllDocs = async () => {
      if (docAll !== null) { setDocAll(null); return }
      try {
        const json = await api('/requirement/get', { id: current.id })
        const map = {}
        for (const item of json.requirement?.docs ?? []) map[item.id] = String(item.content ?? '')
        setDocAll(map)
      } catch (err) { setError(err.message) }
    }
    const saveDoc = async () => {
        if (docForm === null) return
        if (String(docForm.title ?? '').trim() === '') { setDocNote('文档要有标题'); return }
        setDocBusy(true)
        try {
          const json = await api('/requirement/doc', {
            id: current.id,
            action: docForm.id === undefined ? 'add' : 'update',
            docId: docForm.id,
            doc: {
              kind: docForm.kind, title: docForm.title, url: docForm.url,
              version: docForm.version, content: docForm.content, status: docForm.status,
            },
          })
          setDocForm(null)
          setDocNote(null)
          void json
        } catch (err) {
          setDocNote(err.message)
        } finally {
          setDocBusy(false)
        }
      }
      const createFolder = async () => {
        setDriveBusy(true); setDriveNote(null)
        try {
          const json = await api('/requirement/folder', { id: current.id })
          setDriveNote(json.ok ? `云盘文件夹已就绪：${json.folder?.url ?? ''}` : `创建失败：${json.error || json.folder?.error || '未知原因'}`)
        } catch (err) { setDriveNote(err.message) } finally { setDriveBusy(false) }
      }
      const syncReqArtifacts = async () => {
        setDriveBusy(true); setDriveNote(null)
        try {
          const json = await api('/requirement/sync', { id: current.id })
          const report = json.report ?? {}
          const bad = Number(report.failed ?? 0)
          setDriveNote(`归档完成：共 ${report.total ?? 0} 件，成功 ${report.written ?? 0} 件${bad > 0 ? `，失败 ${bad} 件（${report.errors?.[0] ?? ''}）` : '。'}`)
        } catch (err) { setDriveNote(err.message) } finally { setDriveBusy(false) }
      }
      const baselineDoc = async (docId) => {        try {
          await api('/requirement/doc', { id: current.id, action: 'baseline', docId, by: '人' })
          setDocNote('这一版已生效，之后新建的卡都会记下它。')
        } catch (err) {
          setDocNote(err.message)
        }
      }
      const rollbackBaseline = async () => {
        const version = current?.baseline?.version ?? ''
        if (!(await confirmDialog('把 PRD 正文恢复到基线 ' + version + '？版本号会 +1，验收签字作废。', { title: '回滚到基线', okText: '回滚' }))) return
        try {
          await api('/requirement/doc', { id: current.id, action: 'rollback', by: '人' })
          setBaseDiff(null)
          setDocNote('已回滚到基线 ' + version + '：版本号 +1，签字作废。')
          if (typeof onChanged === 'function') onChanged()
        } catch (err) {
          setDocNote(err.message)
        }
      }
      const clearBaseline = async () => {
        try {
          await api('/requirement/doc', { id: current.id, action: 'clear-baseline' })
          setDocNote('基线已取消，需求回到「评审中」。')
        } catch (err) {
          setDocNote(err.message)
        }
      }
      const removeDoc = async (docId) => {
        if (!(await confirmDialog('删除这份文档？', { title: '删除文档', danger: true, okText: '删除' }))) return
        try {
          await api('/requirement/doc', { id: current.id, action: 'remove', docId })
        } catch (err) {
          setDocNote(err.message)
        }
      }
      const pullDoc = async () => {
        setDocBusy(true)
        setDocNote(null)
        try {
          const json = await api('/requirement/pull', { url: docForm?.url ?? '' })
          if (json.ok === true) {
            const pulled = String(json.text ?? '')
            setDocForm(current => ({
              ...current,
              title: String(current?.title ?? '').trim() === '' ? String(json.title ?? '') : current.title,
              content: pulled,
            }))
            setDocNote(`已拉取 ${pulled.length} 字正文${json.title ? `，标题取自文档「${json.title}」` : ''}。`)
          } else {
            setDocNote(json.error ?? '拉取失败')
          }
        } catch (err) {
          setDocNote(err.message)
        } finally {
          setDocBusy(false)
        }
      }

      const closeForm = () => { setForm(null); setError(null) }
      /* 新建/编辑需求走侧滑块：页面本体只留列表与详情，不再把一长串表单铺在顶部。 */
      const formPanel = form === null ? null : h(SideDrawer, {
        title: form.id === undefined ? '新建需求' : `编辑 ${current?.code ?? ''}`,
        hint: intake !== null ? '回答 5 个问题，自动整理成 PRD 草稿；也可以随时切回「直接填写」。' : '先写标题与澄清三问；保存后可在需求详情里继续补功能点、文档与验收条件。',
        onClose: closeForm,
        footer: [
          h(Button, { key: 'cancel', variant: 'secondary', size: 'sm', onClick: closeForm }, '取消'),
          /* 对话还没生成草稿时别给「保存需求」：标题/正文还空着，点了只会报错。 */
          intake === null ? h(Button, { key: 'save', variant: 'primary', size: 'sm', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存需求') : null,
        ],
      },
        h('div', { className: 'flex min-w-0 flex-col gap-3', 'data-intake': intake === null ? '0' : '1', 'data-form-id': form.id ?? 'new', 'data-chat-draft': form.fromChat === true ? '1' : '0' },
          h('div', { className: 'flex flex-wrap items-center gap-2', 'data-intake-switch': '' },
            h(Button, { variant: intake === null ? 'secondary' : 'ghost', size: 'sm', onClick: startIntake }, '先聊清楚'),
            h(Button, { variant: intake === null ? 'ghost' : 'secondary', size: 'sm', onClick: () => setIntake(null) }, '直接填写'),
            h('span', { className: HINT }, intake === null ? '不知道怎么填？用 5 个问题把需求聊成文档' : '答完会生成一份可编辑的 PRD 草稿')),
          renderIntake(),
          h('div', { className: FIELD },
            h('div', { className: LABEL }, '需求标题'),
            h(TextField, { 'aria-label': '需求标题', value: form.title, onChange: e => setForm({ ...form, title: e.target.value }) }),
          ),
          h('div', { className: FIELD },
            h('div', { className: LABEL }, '有没有服务端？数据存在哪、刷新会不会丢'),
            h(TextField, { placeholder: '例：有，node:sqlite；或「纯前端演示，刷新即还原」', value: form.discovery?.server ?? '', onChange: e => setForm({ ...form, discovery: { ...(form.discovery ?? {}), server: e.target.value } }) }),
          ),
          h('div', { className: FIELD },
            h('div', { className: LABEL }, '鉴权谁做：前端隐藏按钮，还是服务端拒绝'),
            h(TextField, { placeholder: '例：服务端校验角色，viewer 调写接口直接 403', value: form.discovery?.auth ?? '', onChange: e => setForm({ ...form, discovery: { ...(form.discovery ?? {}), auth: e.target.value } }) }),
          ),
          h('div', { className: FIELD },
            h('div', { className: LABEL }, '交付边界：只交付界面，还是点开就能用'),
            h(TextField, { placeholder: '例：前后端都交付，含测试；或「只做 UI，接口后续接」', value: form.discovery?.boundary ?? '', onChange: e => setForm({ ...form, discovery: { ...(form.discovery ?? {}), boundary: e.target.value } }) }),
          ),
          h('div', { className: ROW },
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '业务项目'),
              h(Select, {
                className: 'w-full', value: form.project, options: projectOptions,
                'aria-label': '业务项目',
                onChange: e => setForm({ ...form, project: e.target.value }),
              }),
            ),
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '状态'),
              h(Select, {
                className: 'w-full', value: form.status, options: statusOptions,
                'aria-label': '需求状态',
                onChange: e => setForm({ ...form, status: e.target.value }),
              }),
            ),
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '业务负责人'),
              h(TextField, { 'aria-label': '业务负责人', value: form.owner, onChange: e => setForm({ ...form, owner: e.target.value }) }),
            ),
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '业务领域'),
              h(TextField, { placeholder: '支付 / 风控 / 会员（决定派给哪位领域专家）', value: form.domain ?? '', onChange: e => setForm({ ...form, domain: e.target.value }) }),
            ),
          ),
          h('div', { className: FIELD },
            h('div', { className: LABEL }, 'PRD 链接'),
            h(TextField, { placeholder: 'https://…（飞书云文档）', value: form.prd, onChange: e => setForm({ ...form, prd: e.target.value }) }),
          ),
          h('div', { className: ROW },
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '原型链接'),
              h(TextField, { 'aria-label': '原型链接', value: form.proto, onChange: e => setForm({ ...form, proto: e.target.value }) }),
            ),
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '验收标准链接'),
              h(TextField, { 'aria-label': '验收标准链接', value: form.acceptance, onChange: e => setForm({ ...form, acceptance: e.target.value }) }),
            ),
          ),
          h('div', { className: FIELD },
            h('div', { className: LABEL }, '需求正文 / PRD 摘要'),
            h(MdField, {
              rows: 10,
              style: { minHeight: 180 },
              placeholder: '支持 Markdown：`# 背景`、`- 列表`、`**重点**`、`` `代码` ``、`| 表格 |`；保存后在「需求明细」里按 Markdown 渲染，不再截断。',
              value: form.description,
              onChange: e => setForm({ ...form, description: e.target.value }),
            }),
          ),
        ),
      )

      const detail = current === null ? h(EmptyState, { title: '左边选一条需求，或先新建一条。' }) : (() => {
        const tasks = tasksOf(current.id)
        const done = tasks.filter(task => task.status === 'done').length
        const blocked = tasks.filter(task => task.blocked !== undefined && task.blocked !== null).length
        const bugs = tasks.filter(task => task.type === 'bug' && task.status !== 'done').length
        // 用例与清单的正文不在轮询里，只给每张卡一个计数，这里按卡汇总。
        const check = tasks.reduce((acc, task) => {
          const one = checkSummaryOf(task)
          return { done: acc.done + one.done, total: acc.total + one.total }
        }, { done: 0, total: 0 })
        const caseAgg = tasks.reduce((acc, task) => {
          const one = caseSummaryOf(task)
          return { pass: acc.pass + one.pass, total: acc.total + one.total }
        }, { pass: 0, total: 0 })
        const artifacts = tasks.flatMap(task => (task.artifacts ?? []).map(item => ({ ...item, task })))
        const mrs = tasks.filter(task => (task.gitlabMR?.iid ?? 0) > 0)
        const passed = caseAgg.pass
        const links = current.links ?? {}
        const folder = current.folder ?? {}
        const link = (label, url) => url === '' ? null : h('a', { className: LINK, href: url, target: '_blank', rel: 'noreferrer' }, label)
        return h('div', { className: 'flex min-w-0 flex-col gap-3', 'data-requirement-body': '', 'data-req-pane': reqPane },
          h('div', { className: 'flex min-w-0 flex-wrap items-start justify-between gap-3' },
            h('div', null,
              h('div', { className: 'font-mono text-caption-1-medium text-text-tertiary' }, current.code || current.id),
              h('div', { className: 'text-title-2-semibold text-text-primary' }, current.title),
            ),
            h('div', { className: ACTIONS },
              h(Select, {
                className: 'w-32', value: current.status, options: statusOptions,
                'aria-label': '需求状态',
                onChange: e => void setStatus(e.target.value),
              }),
              h(Button, { variant: 'secondary', size: 'sm', onClick: () => setForm({ ...current, ...links }) }, '编辑'),
              h(Button, { variant: 'destructive', size: 'sm', onClick: () => void remove(current.id) }, '删除'),
            ),
          ),
          (() => {
            const tabs = [
              { id: 'overview', label: '概览' },
              { id: 'discuss', label: '沟通' + (Array.isArray(current.comments) && current.comments.length > 0 ? ' ' + current.comments.length : '') },
              { id: 'accept', label: '任务与验收' },
              { id: 'artifacts', label: '交付物' + (artifacts.length > 0 ? ' ' + artifacts.length : '') },
            ]
            return h('div', { className: 'flex flex-wrap items-center gap-1 border-b border-separator-border pb-2', role: 'group', 'aria-label': '需求详情分区' },
              tabs.map(tab => h(Button, {
                key: tab.id, 'aria-pressed': reqPane === tab.id ? 'true' : 'false', 'data-req-tab': tab.id,
                variant: reqPane === tab.id ? 'secondary' : 'ghost', size: 'sm',
                onClick: () => setReqPane(tab.id),
              }, tab.label)))
          })(),
          (() => {
            // 评审：草稿要先过评审才能拆卡；打回会退回草稿并留意见。
            const review = current.review ?? null
            const stateLabel = review === null ? '还没提交评审' : (REVIEW_LABEL[review.status] ?? review.status)
            const canSubmit = review === null || review.status === 'changes_requested'
            const canDecide = review !== null && review.status === 'pending'
            return h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'overview', 'data-review': review === null ? 'none' : review.status },
              h('div', { className: PANEL_HEAD },
                h('span', null, '需求评审'),
                h(Chip, { color: review?.status === 'approved' ? 'lime' : 'gray', className: 'ms-2', 'data-on': review?.status === 'approved' ? '1' : '0' }, stateLabel),
                review === null || review.at === 0 ? null : h('span', { className: HINT, style: { marginLeft: 'auto' } }, `${fmtTime(review.at)}${review.by === '' ? '' : ` · ${review.by}`}`),
              ),
              h('div', { className: PANEL_BODY },
                review !== null && String(review.note ?? '') !== ''
                  ? h('div', { className: HINT, style: { marginBottom: 8 } }, `评审意见：${review.note}`)
                  : null,
                h('div', { className: ROW, style: { flexWrap: 'wrap', gap: 8 } },
                  canSubmit ? h(Button, { variant: 'primary', size: 'sm', disabled: reviewBusy, onClick: () => void reviewRequirement('submit') }, reviewBusy ? '提交中…' : '提交评审') : null,
                  canDecide ? h(Button, { variant: 'primary', size: 'sm', disabled: reviewBusy, onClick: () => void reviewRequirement('approve') }, '评审通过') : null,
                  canDecide ? h(Button, { variant: 'destructive', size: 'sm', disabled: reviewBusy, onClick: rejectReview }, '打回') : null,
                  review?.status === 'approved' ? h('span', { className: HINT }, '评审已通过，可以拆卡和派活了。') : null,
                ),
                reviewNote === null ? null : h('div', { className: HINT, style: { marginTop: 8 } }, reviewNote),
              ),
            )
          })(),
          (() => {
            /* 沟通区：需求级的追问与结论落在这里，而不是覆盖正文或散到卡上（issue #115）。 */
            const comments = Array.isArray(current.comments) ? current.comments : []
            const sendComment = async () => {
              const body = commentDraft.trim()
              if (body === '') return
              setCommentBusy(true)
              try {
                await api('/requirement/comment', { id: current.id, action: 'add', body, by: currentUser() })
                setCommentDraft('')
                toast('已发到需求沟通里')
                if (typeof onChanged === 'function') onChanged()
              } catch (error) { toast(error.message ?? String(error), 'error') }
              finally { setCommentBusy(false) }
            }
            const removeComment = async comment => {
              if (!(await confirmDialog('删掉这条需求沟通？删了之后只在历史里留痕。', { title: '删除沟通', danger: true, okText: '删除' }))) return
              setCommentBusy(true)
              try {
                await api('/requirement/comment', { id: current.id, action: 'remove', commentId: comment.id, by: currentUser() })
                toast('已删除')
                if (typeof onChanged === 'function') onChanged()
              } catch (error) { toast(error.message ?? String(error), 'error') }
              finally { setCommentBusy(false) }
            }
            return h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'discuss', 'data-requirement-comments': '' },
              h('div', { className: PANEL_HEAD },
                h('span', null, '沟通'),
                h('span', { className: HINT, style: { marginLeft: 'auto' } }, comments.length === 0 ? '还没有人在这里说过话' : `${comments.length} 条`),
              ),
              h('div', { className: PANEL_BODY },
                comments.length === 0
                  ? h('div', { className: HINT }, '产品说「这里还要考虑退货」、架构问「边界含不含加盟」，都写在这里：需求页能直接看到，不用翻卡片的评论。')
                  : h('div', { className: 'flex min-w-0 flex-col gap-3', 'data-requirement-comment-list': '' },
                    comments.map((comment, index) => h('div', { key: comment.id, className: 'flex min-w-0 flex-col gap-1 border-b border-separator-border pb-3 last:border-b-0 last:pb-0', 'data-requirement-comment': comment.id },
                      h('div', { className: 'flex flex-wrap items-center gap-2' },
                        h('span', { className: 'text-body-2-medium text-text-primary' }, comment.by || '人'),
                        h('span', { className: HINT }, fmtTime(comment.at)),
                        (comment.edits ?? []).length > 0 ? h(Chip, { color: 'gray' }, `改过 ${comment.edits.length} 次`) : null,
                        h(Button, { variant: 'ghost', size: 'sm', className: 'ms-auto', disabled: commentBusy, onClick: () => void removeComment(comment) }, '删除'),
                      ),
                      h('div', { className: 'md-content text-text-primary', 'data-requirement-comment-body': '' }, renderMarkdown(String(comment.body ?? ''))),
                    )),
                  ),
                h('div', { className: 'mt-3 flex min-w-0 flex-col gap-2', 'data-requirement-comment-composer': '' },
                  h(TextAreaField, {
                    rows: 3,
                    placeholder: '写在这里的都会出现在需求页（支持 Markdown，Ctrl/⌘+Enter 发送）',
                    value: commentDraft,
                    onChange: event => setCommentDraft(event.target.value),
                    onKeyDown: event => {
                      if ((event.metaKey || event.ctrlKey) && (event.key === 'Enter' || event.key === 'NumpadEnter')) {
                        event.preventDefault()
                        void sendComment()
                      }
                    },
                  }),
                  h('div', { className: ROW, style: { justifyContent: 'flex-end' } },
                    h(Button, { variant: 'primary', size: 'sm', disabled: commentBusy || commentDraft.trim() === '', onClick: () => void sendComment() }, commentBusy ? '发送中…' : '发送'),
                  ),
                ),
              ),
            )
          })(),
          (link('PRD', links.prd) || link('原型', links.proto) || link('验收标准', links.acceptance))
            ? h('div', { className: ROW, 'data-req-panel': 'overview' }, link('PRD 文档', links.prd), link('原型', links.proto), link('验收标准', links.acceptance))
            : h('div', { className: 'flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-separator-border bg-background-secondary-default px-3 py-3 text-body-2-regular text-text-secondary', 'data-req-panel': 'overview' }, [h('span', null, '还没有登记 PRD / 原型 / 验收标准链接；PRD 与原型由产品在澄清后输出，可在这里补，或点右边「让产品补 PRD」。'), h(Button, { variant: 'ghost', size: 'sm', className: 'ms-2', onClick: async () => { const note = await promptDialog('想请产品补什么？', { title: '申请产品补 PRD', defaultValue: '需要产品输出 PRD 与原型' }); if (note === null) return; try { await api('/requirement/request-prd', { id: current.id, by: currentUser(), note }); toast('已申请产品补 PRD'); onChanged() } catch (error) { toast(error.message ?? String(error), 'error') } } }, '让产品补 PRD')]),
          current.description
            ? h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'overview' },
              h('div', { className: PANEL_HEAD },
                h('span', null, '需求明细'), current.source === 'business' ? h('span', { className: HINT, 'data-src': 'business' }, `业务提单 · ${current.requester?.name || '未署名'}${current.requester?.dept ? '（' + current.requester.dept + '）' : ''} · ${fmtTime(current.requester?.at || current.createdAt)}`) : null,
                h('span', { className: HINT, style: { marginLeft: 'auto' } }, '支持 Markdown'),
              ),
              h('div', { className: PANEL_BODY },
                h('div', { className: 'md-content text-text-primary', 'data-requirement-desc': '' }, renderMarkdown(current.description)),
              ),
            )
            : h('div', { className: HINT }, '还没有写需求描述：产品背景、要解决的问题、验收口径都建议写在这里，点右侧「编辑」补上。'),
(() => {
            // 变更记录：字段级 diff，谁在什么时候把标题/正文/优先级/状态/负责人/项目/迭代改了。
            const history = (current.history ?? []).slice().reverse()
            if (history.length === 0 || (current.change ?? null) !== null) return null
            const label = { title: '标题', description: '需求明细', priority: '优先级', status: '状态', owner: '负责人', project: '项目', iteration: '迭代' }
            return h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'overview' },
              h('div', { className: PANEL_HEAD },
                h('span', null, '变更记录'),
                h('span', { className: HINT, style: { marginLeft: 'auto' } }, `最近 ${history.length} 条`),
              ),
              h('div', { className: PANEL_BODY },
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' } },
                  history.map((item, index) => h('div', { key: `${item.at}-${index}`, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 } },
                    h('span', { className: HINT, style: { flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, fmtTime(item.at)),
                    h('span', { style: { flex: '0 0 auto' } }, item.by === '' ? '人' : item.by),
                    h(Chip, { color: 'gray', className: 'shrink-0' }, label[item.field] ?? item.field),
                    h('span', { className: HINT, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      `${item.from === '' ? '（空）' : item.from} → ${item.to === '' ? '（空）' : item.to}`),
                  )),
                ),
              ),
            )
          })(),
          (() => {
            // 需求池打分：RICE，影响面 × 影响度 × 置信度 / 成本，用来给需求排序。
            const pool = current.pool ?? { reach: 0, impact: 0, confidence: 0, effort: 0, score: 0 }
            const ask = async (label, hint, currentValue) => {
              const raw = await promptDialog(hint, { title: label, defaultValue: String(currentValue ?? 0) })
              if (raw === null) return null
              const value = Number(String(raw).trim())
              return Number.isFinite(value) && value >= 0 ? value : null
            }
            const score = async () => {
              const reach = await ask('影响面 Reach', '影响多少用户或多少笔交易？估算依据写进正文', pool.reach); if (reach === null) return
              const impact = await ask('影响度 Impact', '3 显著 / 2 高 / 1 中 / 0.5 低', pool.impact); if (impact === null) return
              const confidence = await ask('置信度 Confidence', '100 有数据 / 80 有访谈 / 50 只有猜测（百分数）', pool.confidence); if (confidence === null) return
              const effort = await ask('成本 Effort', '人日（研发+测试+联调）', pool.effort); if (effort === null) return
              try { await api('/requirement/pool', { id: current.id, pool: { reach, impact, confidence, effort } }); toast('需求池评分已更新'); await onChanged() }
              catch (cause) { toast(cause instanceof Error ? cause.message : String(cause), 'error') }
            }
            return h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'overview' },
              h('div', { className: PANEL_HEAD },
                h('span', null, '需求池评分（RICE）'),
                h('span', { className: HINT, style: { marginLeft: 'auto' } }, pool.score > 0 ? `得分 ${pool.score}` : '还没打分：不打分就没法和别的需求比优先级'),
                h(Button, { variant: 'ghost', size: 'sm', style: { marginLeft: 8 }, onClick: () => void score() }, pool.score > 0 ? '重新打分' : '打分'),
              ),
              pool.score > 0 ? h('div', { className: PANEL_BODY }, h('div', { className: ROW, style: { flexWrap: 'wrap', gap: 8 } },
                h(Chip, { color: 'gray' }, `影响面 ${pool.reach}`),
                h(Chip, { color: 'gray' }, `影响度 ${pool.impact}`),
                h(Chip, { color: 'gray' }, `置信度 ${pool.confidence}%`),
                h(Chip, { color: 'gray' }, `成本 ${pool.effort} 人日`),
                h(Chip, { color: 'lime', 'data-on': '1' }, `得分 ${pool.score}`),
              )) : null,
            )
          })(),
                    (() => {
            // 待确认清单：澄清阶段没定下来的问题，回答完才允许拆卡。
            const questions = current.questions ?? []
            const openCount = questions.filter(item => item.status === 'open').length
            const call = async (body, done) => {
              try { await api('/requirement/questions', { id: current.id, ...body }); if (done) toast(done); await onChanged() }
              catch (cause) { toast(cause instanceof Error ? cause.message : String(cause), 'error') }
            }
            const addQuestion = async () => {
              const text = await promptDialog('还没确认清楚的问题是什么？', { title: '加一个待确认问题', placeholder: '例如：退款失败时是否允许人工补发？' })
              if (text === null || text.trim() === '') return
              await call({ action: 'add', text }, '已加入待确认清单')
            }
            const answerQuestion = async item => {
              const answer = await promptDialog(item.text, { title: '回答这个问题', defaultValue: item.answer ?? '', placeholder: '写清结论与依据' })
              if (answer === null || answer.trim() === '') return
              await call({ action: 'answer', questionId: item.id, answer }, '已回答')
            }
            const removeQuestion = async item => {
              const ok = await confirmDialog('删掉这个问题？', { title: '删除待确认项', danger: true, okText: '删除' })
              if (ok !== true) return
              await call({ action: 'delete', questionId: item.id }, '已删除')
            }
            return h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'overview', 'data-open': openCount > 0 ? '1' : '0' },
              h('div', { className: PANEL_HEAD },
                h('span', null, '待确认清单'),
                h('span', { className: HINT, style: { marginLeft: 'auto' } }, openCount > 0 ? `${openCount} 个没回答，回答完才能拆卡` : (questions.length === 0 ? '澄清阶段把不确定的先记在这里' : '全部已回答')),
                h(Button, { variant: 'ghost', size: 'sm', style: { marginLeft: 8 }, onClick: () => void addQuestion() }, '＋ 加问题'),
              ),
              h('div', { className: PANEL_BODY },
                questions.length === 0
                  ? h(EmptyState, { title: '还没有待确认的问题。产品澄清时把「需要业务拍板」的点写在这里，避免猜业务规则。' })
                  : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, questions.map(item => h('div', {
                    key: item.id,
                    className: 'flex min-w-0 items-start gap-3 rounded-lg border border-separator-border bg-background-primary-default px-3 py-2',
                    'data-status': item.status,
                  },
                    h(Chip, { color: item.status === 'answered' ? 'lime' : 'yellow', 'data-on': item.status === 'answered' ? '1' : '0' }, item.status === 'answered' ? '已回答' : '待回答'),
                    h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                      h('div', { style: { fontSize: 13 } }, item.text),
                      item.answer === '' || item.answer === undefined ? null : h('div', { className: HINT, style: { marginTop: 4 } }, `答：${item.answer}`),
                    ),
                    h('div', { style: { display: 'flex', gap: 8, flex: '0 0 auto' } },
                      h(Button, { variant: 'ghost', size: 'sm', onClick: () => void answerQuestion(item) }, item.status === 'answered' ? '改答案' : '回答'),
                      h(Button, { variant: 'destructive', size: 'sm', onClick: () => void removeQuestion(item) }, '删除'),
                    ),
                  ))),
              ),
            )
          })(),
          (() => {
            // 变更影响：需求改过之后，已经产出过东西的卡要按新版复核，签过的字已经作废。
            const change = current.change ?? null
            if (change === null) return null
            const affected = change.affected ?? []
            const affectedCases = change.affectedCases ?? []
            const byId = new Map(tasks.map(task => [task.id, task]))
            const statusLabel = id => (state.statuses.find(entry => entry.id === id)?.label) ?? id
            return h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'overview', 'data-invalidated': change.invalidated ? '1' : '0' },
              h('div', { className: PANEL_HEAD },
                h('span', null, change.invalidated ? '变更影响（签字已作废）' : '变更影响'),
                h('span', { className: HINT, style: { marginLeft: 'auto' } },
                  `${fmtTime(change.at)}${change.by === '' ? '' : ` · ${change.by}`}`),
              ),
              h('div', { className: PANEL_BODY },
                (function () {
                  const rows = (current.history ?? []).slice().reverse()
                  if (rows.length === 0) return null
                  const label = { title: '标题', description: '需求明细', priority: '优先级', status: '状态', owner: '负责人', project: '项目', iteration: '迭代' }
                  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto', marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed var(--border)' } },
                    h('div', { className: HINT, style: { fontWeight: 600 } }, `变更记录 · 最近 ${rows.length} 条`),
                    rows.map((item, index) => h('div', { key: `${item.at}-${index}`, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 } },
                      h('span', { className: HINT }, fmtTime(item.at)),
                      h('span', null, item.by === '' ? '人' : item.by),
                      h(Chip, { color: 'gray' }, label[item.field] ?? item.field),
                      h('span', { className: HINT }, `${item.from === '' ? '（空）' : item.from} → ${item.to === '' ? '（空）' : item.to}`),
                    )),
                  )
                })(),
                h('div', { className: HINT },
                  `改了：${(change.parts ?? []).join('、')}。${affected.length === 0
                    ? '当时没有已产出的卡受影响，不用返工。'
                    : `${affected.length} 张卡已经产出过东西${affectedCases.length === 0 ? '' : `、${affectedCases.length} 条用例要重跑`}，要按新版复核：`}`),
                affected.length === 0 ? null : h('div', { className: ROW, style: { flexWrap: 'wrap', gap: 8, marginTop: 8 } },
                  affected.map(item => h(Chip, {
                    key: item.id,
                    color: 'yellow',
                    'data-pt': 'open',
                    className: 'cursor-pointer',
                    title: item.title,
                    onClick: () => {
                      const task = byId.get(item.id)
                      if (task !== undefined && typeof onOpenTask === 'function') onOpenTask(task)
                    },
                  }, `${item.code || item.id} ${statusLabel(item.status)}`)),
                ),
                change.invalidated ? h('div', { className: HINT, style: { marginTop: 8 } }, '验收签字已清空：这些卡是按旧版做的，复核完重新签一次。') : null,
              ),
            )
          })(),
          // 上线足迹：这条需求对应的版本上过哪些环境（部署记录是人工登记的，平台不触发部署）。
          (() => {
            const deploys = current.deploys ?? []
            if (deploys.length === 0) return null
            return h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'overview' },
              h('div', { className: PANEL_HEAD },
                h('span', null, '上线足迹'),
                h('span', { className: HINT, style: { marginLeft: 'auto' } }, '来自版本的部署记录，只留痕不触发'),
              ),
              h('div', { className: PANEL_BODY },
                h('div', { className: ROW, style: { flexWrap: 'wrap', gap: 8 } },
                  deploys.map(item => h(Chip, {
                    key: item.id,
                    color: 'soft',
                    'data-env': item.kind,
                    title: `${item.releaseName ?? ''} · ${fmtTime(item.at)} · ${item.by}`,
                  }, `${item.name} · ${fmtDate(item.at)}`)),
                ),
              ),
            )
          })(),
          h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'overview' },
            h('div', { className: PANEL_HEAD }, h('span', null, '依赖与排序')),
            h('div', { className: PANEL_BODY },
              h('div', { className: ROW },
                h('span', { className: HINT }, '排序号'),
                h(TextField, { 'aria-label': '排序号', style: { width: 90 }, value: reqOrder, onChange: e => setReqOrder(e.target.value) }),
                h('span', { className: HINT }, '被依赖的需求没交付，这条需求的准出会被拦'),
              ),
              h('div', { className: ROW, style: { flexWrap: 'wrap', gap: 12 } },
                requirements.filter(item => item.id !== current.id).map(item => h('label', { key: item.id, className: 'flex items-start gap-2 border-b border-separator-border py-2 last:border-b-0' },
                  h(CheckField, { checked: reqDeps.includes(item.id),
                    onChange: event => setReqDeps(done => event.target.checked ? [...done, item.id] : done.filter(id => id !== item.id)),
                  }),
                  h('span', { className: 'text-body-2-regular text-text-primary' }, `${item.code || item.id} ${item.title}（${REQ_STATUS_LABEL[item.status] ?? item.status}）`),
                )),
                requirements.length <= 1 ? h('span', { className: HINT }, '只有这一条需求，暂时没有可依赖的对象。') : null,
              ),
              h('div', { className: ROW },
                h(Button, { variant: 'primary', size: 'sm', onClick: () => void saveDeps() }, '保存排序与依赖'),
                depNote === null ? null : h('span', { className: HINT }, depNote),
              ),
            ),
          ),
          (() => {
            // 需求级门禁：卡全完成 + 功能点全覆盖 + 无阻塞/未结缺陷/失败用例 + 人工签字
            const progress = current.progress ?? null
            const gate = progress?.gate ?? { ready: false, blockers: ['还没有加载出准出状态，稍后自动刷新'], warnings: [] }
            const stats = gate.stats ?? {}
            const signoff = current.signoff ?? null
            const pct = progress?.progress ?? (tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100))
            const covered = stats.coveredPoints ?? 0
            const pointTotal = stats.points ?? (current.points ?? []).length
            const casePass = stats.pass ?? passed
            const caseTotal = stats.cases ?? caseAgg.total
            return h('div', { className: `${PANEL} mt-4`, 'data-req-panel': 'accept' },
              h('div', { className: PANEL_HEAD },
                h('span', null, '需求准出与验收签字'),
                h(Chip, { color: gate.ready ? 'lime' : 'yellow', className: 'ms-auto', 'data-pt': gate.ready ? 'covered' : 'open' },
                  gate.ready ? '可以交付' : `还差 ${gate.blockers.length} 项`),
              ),
              h('div', { className: PANEL_BODY },
                h('div', { className: 'flex min-w-0 flex-col gap-1', 'data-check-progress': pct },
                  h(ProgressTrack, { percentage: pct, size: 'sm' }),
                  h('div', { className: HINT },
                    `${pct}% · ${done}/${tasks.length} 张卡完成 · 功能点覆盖 ${covered}/${pointTotal} · 用例通过 ${casePass}/${caseTotal}`),
                ),
                (() => {
                  /* blocker + warning 一多就是十几行：先露 5 条，其余折叠，避免首屏只剩一片字。 */
                  const items = [
                    ...(gate.blockers ?? []).map(line => ({ kind: 'block', line })),
                    ...(gate.warnings ?? []).map(line => ({ kind: 'warn', line })),
                  ]
                  const head = items.slice(0, 5)
                  const rest = items.slice(5)
                  const row = item => h('div', {
                    key: item.kind + ':' + item.line,
                    className: item.kind === 'block' ? 'text-caption-1-regular text-text-error-primary' : 'text-caption-1-regular text-status-yellow-text',
                    'data-kind': item.kind,
                  }, item.line)
                  return [
                    head.map(row),
                    rest.length === 0 ? null : h('details', { key: 'gate-rest', 'data-gate-more': String(rest.length) },
                      h('summary', { className: 'cursor-pointer text-caption-1-medium text-text-secondary' }, `展开其余 ${rest.length} 条`),
                      h('div', { className: 'mt-1 flex min-w-0 flex-col gap-1' }, rest.map(row))),
                  ]
                })(),
                gate.ready ? h('div', { className: HINT }, '门禁已通过：签完字这条需求就算交付。') : null,
                signoff === null
                  ? h('div', { className: 'flex flex-wrap items-center gap-3 rounded-lg bg-background-secondary-default px-3 py-2' },
                    h(TextField, {
                      style: { flex: 1, minWidth: 220 },
                      placeholder: '验收结论：交付了什么、遗留什么',
                      value: reqSign, onChange: e => setReqSign(e.target.value),
                    }),
                    h(Button, { variant: 'primary', size: 'sm', onClick: () => void signRequirement('sign') }, '需求验收签字'),
                  )
                  : h('div', { className: 'flex flex-wrap items-center gap-3 rounded-lg bg-background-secondary-default px-3 py-2' },
                    h('div', { className: HINT, style: { flex: 1 } }, `${signoff.by} 于 ${fmtTime(signoff.at)} 签字：${signoff.note}`),
                    h(Button, { variant: 'ghost', size: 'sm', onClick: () => void signRequirement('clear') }, '取消签字'),
                  ),
                reqNote === null ? null : h('div', { className: HINT }, reqNote),
              ),
            )
          })(),
          h('div', { 'data-req-panel': 'artifacts', className: 'flex min-w-0 flex-col gap-3' },
          h('div', { className: SECTION }, '交付物归档（飞书云盘）',
            h('div', { className: ACTIONS },
              folder.url ? h('a', { className: LINK, href: folder.url, target: '_blank', rel: 'noreferrer' }, '打开文件夹') : null,
              h(Button, { variant: 'ghost', size: 'sm', disabled: driveBusy, onClick: () => void createFolder() }, folder.url ? '校验文件夹' : '创建文件夹'),
              h(Button, {
                variant: 'secondary', size: 'sm', disabled: driveBusy || artifacts.length === 0,
                onClick: () => void syncReqArtifacts(),
              }, driveBusy ? '归档中…' : `归档 ${artifacts.length} 件交付物`),
            )),
          h('div', { className: HINT }, folder.url
            ? `文件夹：${folder.name || folder.token}　已归档 ${artifacts.filter(item => item.doc?.url).length}/${artifacts.length} 件交付物`
            : (folder.error ? `上次创建失败：${folder.error}` : '还没有云盘文件夹；建好后，这条需求下每件交付物都会写成文件夹里的一份 Markdown 文档。')),
          driveNote ? h('div', { className: HINT }, driveNote) : null,
          h('div', { className: SECTION }, '文档与基线',
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => void openDoc(null) }, '＋ 添加文档'),
          ),
          current.baseline
            ? h('div', { className: 'flex flex-wrap items-center justify-between gap-3 rounded-lg border border-separator-border bg-background-secondary-default px-3 py-2' },
              h('div', { className: 'flex min-w-0 flex-col gap-1' },
                h('b', { className: 'text-body-2-medium text-text-primary' }, `当前基线 ${current.baseline.version}`),
                h('span', null, `${current.baseline.title} · 生效于 ${fmtTime(current.baseline.at)} · ${current.baseline.by || '人'} · 正文 ${current.baseline.contentLength ?? 0} 字`),
              ),
              h(Button, { variant: 'ghost', size: 'sm', title: '把当前文档和这份基线逐行比一遍（只读）', onClick: () => void compareBaseline() }, baseDiff === null ? '对比基线' : '收起对比'),
              h(Button, { variant: 'ghost', size: 'sm', title: '把正文恢复到这一版基线；版本号 +1，签字作废', onClick: () => void rollbackBaseline() }, '回滚到基线'),
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => void clearBaseline() }, '取消基线'),
            )
            : h('div', { className: 'flex flex-wrap items-center justify-between gap-3 rounded-lg border border-separator-border px-3 py-2', 'data-empty': '1' },
              h('div', { className: 'flex min-w-0 flex-col gap-1' },
                h('b', { className: 'text-body-2-medium text-text-primary' }, '还没有基线'),
                h('span', null, 'PRD 评审通过后点「设为基线」，之后建的卡都会记下用的是哪一版。'),
              ),
            ),
          current.baseline !== null && baseDiff !== null
            ? h('div', { className: 'mt-3 flex min-w-0 flex-col overflow-hidden rounded-xl border border-separator-border' },
              h('div', { className: 'flex flex-wrap items-center gap-2 border-b border-separator-border bg-background-secondary-default px-3 py-2 text-body-2-medium' },
                h('b', null, `基线 ${baseDiff.version} → 当前：${baseDiff.docTitle}`),
                h('span', { className: HINT }, baseDiff.summary.added + baseDiff.summary.removed === 0
                  ? '正文没有变化'
                  : `+${baseDiff.summary.added} 行 / −${baseDiff.summary.removed} 行`),
              ),
              h('div', { className: 'max-h-80 overflow-auto p-2 font-mono text-caption-1-regular' },
                baseDiff.rows.slice(0, 400).map((row, index) => h('div', {
                  key: index,
                  className: row.kind === 'add'
                    ? 'whitespace-pre-wrap rounded bg-background-tertiary-default px-2 py-1 text-status-lime-text'
                    : row.kind === 'del'
                      ? 'whitespace-pre-wrap rounded bg-background-tertiary-error px-2 py-1 text-text-error-primary'
                      : 'whitespace-pre-wrap px-2 py-1 text-text-tertiary',
                  'data-kind': row.kind,
                }, `${row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '} ${row.text}`)),
                baseDiff.rows.length > 400 ? h('div', { className: HINT }, `（还有 ${baseDiff.rows.length - 400} 行未显示）`) : null,
              ),
            )
            : null,
          (current.docs ?? []).length === 0
            ? h('div', { className: HINT, style: { marginTop: 8 } }, '还没有登记文档。可以先加 PRD 链接，把正文粘进来，评审通过后设为基线。')
            : h('div', null,
              h('div', { className: ROW, style: { marginTop: 8, gap: 8, alignItems: 'center' } },
                h(Button, { variant: 'ghost', size: 'sm', onClick: () => void expandAllDocs() }, docAll === null ? '全部展开' : '全部收起'),
                h('span', { className: HINT }, `共 ${(current.docs ?? []).length} 篇，展开后可直接读 Markdown 正文`)),
              h('div', { className: 'mt-2 flex min-w-0 flex-col' }, (current.docs ?? []).map(doc => h('div', { key: doc.id, className: 'flex min-w-0 flex-col' }, h('div', { className: 'flex min-w-0 items-start justify-between gap-4 border-b border-separator-border py-2 last:border-b-0' },
              h(Chip, { color: 'soft', 'data-doc': doc.kind }, DOC_KIND_LABEL[doc.kind] ?? doc.kind),
              h('div', { className: LISTROW_MAIN },
                h('div', { className: 'flex flex-wrap items-center gap-2 text-body-2-medium text-text-primary' },
                  doc.url === '' ? doc.title : h('a', { className: LINK, href: doc.url, target: '_blank', rel: 'noreferrer' }, doc.title),
                  h('span', { className: CODE }, doc.version),
                  h(Chip, { color: 'gray', 'data-docstatus': doc.status }, DOC_STATUS_LABEL[doc.status] ?? doc.status),
                ),
                h('div', { className: HINT }, `正文 ${doc.contentLength ?? 0} 字 · ${doc.by || '—'} · ${doc.at > 0 ? fmtTime(doc.at) : '—'}`),
              ),
              h('div', { className: ACTIONS },
                doc.status === 'baseline' ? null : h(Button, { variant: 'ghost', size: 'sm', onClick: () => void baselineDoc(doc.id) }, '设为基线'),
                h(Button, { variant: 'ghost', size: 'sm', title: '直接读正文（Markdown 渲染）', onClick: () => void readDoc(doc.id) }, docReader !== null && docReader.id === doc.id ? '收起' : '阅读'),
                h(Button, { variant: 'ghost', size: 'sm', onClick: () => void openDoc(doc.id) }, '编辑'),
                h(Button, { variant: 'destructive', size: 'sm', onClick: () => void removeDoc(doc.id) }, '删除'),
              ),
            ),
            docReader !== null && docReader.id === doc.id
              ? h('div', { className: 'md-content mt-2 rounded-xl border border-separator-border bg-background-secondary-default p-3' }, docReader.busy
                ? h('span', { className: HINT }, '读取中…')
                : (docReader.content.trim() === '' ? h('span', { className: HINT }, '这条文档还没有正文。') : renderMarkdown(docReader.content)))
              : (docAll !== null && docAll[doc.id] !== undefined
                ? h('div', { className: 'md-content mt-2 rounded-xl border border-separator-border bg-background-secondary-default p-3' }, docAll[doc.id].trim() === ''
                  ? h('span', { className: HINT }, '这条文档还没有正文。')
                  : renderMarkdown(docAll[doc.id]))
                : null),
            )))),
          docNote === null ? null : h('div', { className: HINT, style: { marginTop: 8 } }, docNote),
          docForm === null ? null : h('div', { className: `${PANEL} mt-3` },
            h('div', { className: PANEL_HEAD }, docForm.id === undefined ? '添加文档' : `编辑 ${docForm.title}`),
            h('div', { className: PANEL_BODY },
              h('div', { className: ROW, style: { gap: 12 } },
                h('div', { className: FIELD, style: { flex: '0 0 150px' } },
                  h('div', { className: LABEL }, '类型'),
                  h(Select, {
                    className: 'w-full', value: docForm.kind, options: docKindOptions,
                    'aria-label': '文档类型',
                    onChange: e => setDocForm({ ...docForm, kind: e.target.value }),
                  }),
                ),
                h('div', { className: FIELD, style: { flex: '1 1 220px' } },
                  h('div', { className: LABEL }, '标题'),
                  h(TextField, { value: docForm.title, placeholder: '例如 会员积分抵扣 PRD', onChange: e => setDocForm({ ...docForm, title: e.target.value }) }),
                ),
                h('div', { className: FIELD, style: { flex: '0 0 110px' } },
                  h('div', { className: LABEL }, '版本'),
                  h(TextField, { value: docForm.version, placeholder: 'v1.0', onChange: e => setDocForm({ ...docForm, version: e.target.value }) }),
                ),
              ),
              h('div', { className: ROW, style: { gap: 12 } },
                h('div', { className: FIELD, style: { flex: '1 1 auto' } },
                  h('div', { className: LABEL }, '飞书文档链接'),
                  h(TextField, { value: docForm.url, placeholder: 'https://<租户>.feishu.cn/wiki/…', onChange: e => setDocForm({ ...docForm, url: e.target.value }) }),
                ),
                h('div', { className: FIELD, style: { flex: '0 0 auto', justifyContent: 'flex-end' } },
                  h('div', { className: LABEL }, ' '),
                  h(Button, { variant: 'secondary', size: 'sm', disabled: docBusy, onClick: () => void pullDoc() }, docBusy ? '拉取中…' : '从链接拉正文'),
                ),
              ),
              h('div', { className: FIELD },
                h('div', { className: LABEL }, '文档正文（拉不到就自己粘，研发和测试都读这一份）'),
                h(MdField, { rows: 8, value: docForm.content, onChange: e => setDocForm({ ...docForm, content: e.target.value }) }),
              ),
              h('div', { className: ROW, style: { justifyContent: 'flex-end', gap: 8 } },
                h(Button, { variant: 'secondary', size: 'sm', onClick: () => { setDocForm(null); setDocNote(null) } }, '取消'),
                h(Button, { variant: 'primary', size: 'sm', disabled: docBusy, onClick: () => void saveDoc() }, '保存文档'),
              ),
            ),
          ),
          ),
          h('div', { 'data-req-panel': 'accept', className: 'flex min-w-0 flex-col gap-3' },
          h('div', { className: SECTION },
            h('div', { className: 'text-body-2-medium text-text-primary' }, '需求变更影响面'),
            h('div', { className: 'max-w-2xl text-caption-1-regular text-text-tertiary' }, '需求一改，下面这些卡和用例就要重看。点一下现算，不改任何数据。'),
          ),
          h('div', { className: ROW, style: { gap: 8, alignItems: 'center', marginBottom: 8 } },
            h(Button, { variant: 'secondary', size: 'sm', disabled: impactBusy || currentForDeps === null, onClick: () => void loadImpact() }, impactBusy ? '计算中…' : '算一下影响面'),
            impact === null
              ? h('span', { className: HINT }, '还没算过')
              : h('span', { className: HINT }, `卡 ${impact.summary.cards} · 用例 ${impact.summary.cases}（能自动跑 ${impact.summary.runnable}）· 失败 ${impact.summary.failing}${impact.summary.staleCases > 0 ? ` · 需复跑 ${impact.summary.staleCases}` : ''}`),
          ),
          impact === null || impact.cards.length === 0
            ? null
            : h('div', { className: 'flex max-h-40 flex-col gap-2 overflow-auto' },
              impact.cards.slice(0, 12).map(item => h('div', { key: item.id, className: 'flex min-w-0 items-center gap-2 border-b border-separator-border py-2 last:border-b-0' },
                h('span', { className: 'min-w-0 truncate text-body-2-medium text-text-primary' }, (item.code === '' ? '' : item.code + ' ') + item.title),
                h('span', { className: HINT }, item.status),
              )),
              impact.cards.length > 12 ? h('div', { className: HINT }, `还有 ${impact.cards.length - 12} 张`) : null,
            ),
          h('div', { className: SECTION },
            h('div', { className: 'text-body-2-medium text-text-primary' }, '功能点与可追溯矩阵'),
            h('div', { className: 'max-w-2xl text-caption-1-regular text-text-tertiary' }, '功能点是需求的骨架：一条功能点对若干张卡、若干条用例。卡和用例上都挂 pointId，这里就能看出哪条没人做、哪条没被验证。'),
          ),
          matrix === null
            ? h('div', { className: HINT, style: { padding: '8px 0' } }, '还没有功能点。点「＋ 加功能点」把需求拆成可交付、可验证的条目。')
            : h('div', { className: 'mt-2 flex min-w-0 flex-col gap-2' },
              h('div', { className: 'text-caption-1-regular text-text-secondary' },
                `功能点 ${matrix.summary.points} · 已覆盖 ${matrix.summary.coveredPoints}${matrix.summary.pointsWithoutCases > 0 ? `（${matrix.summary.pointsWithoutCases} 条还没有用例，覆盖率 ${matrix.summary.coverageRate}%）` : ''} · 卡 ${matrix.summary.cards}（未归点 ${matrix.summary.looseCards}）· 用例 ${matrix.summary.cases}（通过 ${matrix.summary.pass}${matrix.summary.fail > 0 ? `，失败 ${matrix.summary.fail}` : ''}${matrix.summary.staleCases > 0 ? `，需复跑 ${matrix.summary.staleCases}` : ''}）· 通过率 ${matrix.summary.passRate}%`,
              ),
              /* 口径写明白：不然读者会自己推断成"一卡一点，覆盖率有天花板"（issue #9 第 5 条的真事） */
              h('div', { className: HINT, style: { marginBottom: 8 } },
                '覆盖率按功能点算：一个功能点可以对应多张卡、多条用例。用例自带的 pointId 优先——同一张卡上的用例可以分别覆盖不同功能点（没填就沿用卡上的功能点）。'),
              /* 官方 Table：需求矩阵本来就是一张表（编号 / 功能点 / 覆盖 / 卡与用例 / 操作），
                 原来是一串 div 拼的功能点行。RAC 的 collection 组件不能被自定义组件包住，
                 所以直接用 table.tsx 的再导出。 */
              /* 勾选 + 批量覆盖验收条件 */
              h('div', { className: 'mb-2 flex min-w-0 flex-wrap items-center gap-2', 'data-point-bulk': '' },
                h('span', { className: HINT }, `已选 ${selectedPointIds.size} 个功能点`),
                h(Button, { variant: 'secondary', size: 'sm', disabled: selectedPointIds.size === 0, onClick: () => setBulkAcceptance({ text: '' }) }, '批量设验收条件'),
                selectedPointIds.size === 0 ? null : h(Button, { variant: 'ghost', size: 'xs', onClick: () => setSelectedPointIds(new Set()) }, '清除选择')),
              bulkAcceptance === null ? null : h('div', { className: `${PANEL} mb-2`, 'data-point-bulk-form': '' },
                h('div', { className: PANEL_HEAD }, `批量设置验收条件（已选 ${selectedPointIds.size} 个）`),
                h('div', { className: PANEL_BODY },
                  h('div', { className: HINT }, '一行一条，会替换所选功能点的全部验收条件；已挂在这些条件下的用例会变成「未挂条件」。'),
                  h(TextAreaField, { rows: 4, value: bulkAcceptance.text, 'aria-label': '批量验收条件', onChange: event => setBulkAcceptance({ text: event.target.value }) }),
                  h('div', { className: ROW, style: { justifyContent: 'flex-end', gap: 8 } },
                    h(Button, { variant: 'secondary', size: 'sm', onClick: () => setBulkAcceptance(null) }, '取消'),
                    h(Button, { variant: 'primary', size: 'sm', onClick: () => void applyBulkAcceptance() }, '替换验收条件'),
                  ),
                ),
              ),
          pointForm === null ? null : h('div', { className: `${PANEL} mb-2`, ref: pointFormRef, 'data-point-form': '' },
            h('div', { className: PANEL_HEAD }, pointForm.id === undefined ? '新增功能点' : `编辑功能点 ${pointForm.id}`),
            h('div', { className: PANEL_BODY },
              h('div', { className: FIELD },
                h('div', { className: LABEL }, '功能点标题'),
                h(TextField, { value: pointForm.title, placeholder: '例如 结算页展示可用积分', onChange: event => setPointForm({ ...pointForm, title: event.target.value }) }),
              ),
              h('div', { className: FIELD },
                h('div', { className: LABEL }, '说明'),
                h(MdField, { rows: 3, value: pointForm.description ?? '', onChange: event => setPointForm({ ...pointForm, description: event.target.value }) }),
              ),
              h('div', { className: FIELD },
                h('div', { className: LABEL }, '验收条件（一行一条，做成什么样算完成）'),
                h(TextAreaField, { rows: 4, value: pointForm.acceptanceText ?? '', onChange: event => setPointForm({ ...pointForm, acceptanceText: event.target.value }) }),
              ),
              h('div', { className: ROW, style: { gap: 12 } },
                h('div', { className: FIELD, style: { flex: '0 0 150px' } },
                  h('div', { className: LABEL }, '优先级'),
                  h(Select, {
                    className: 'w-full', value: pointForm.priority, options: pointPriorityOptions,
                    'aria-label': '功能点优先级',
                    onChange: event => setPointForm({ ...pointForm, priority: event.target.value }),
                  }),
                ),
                h('div', { className: FIELD, style: { flex: '0 0 150px' } },
                  h('div', { className: LABEL }, '状态'),
                  h(Select, {
                    className: 'w-full', value: pointForm.status, options: pointStatusOptions,
                    'aria-label': '功能点状态',
                    onChange: event => setPointForm({ ...pointForm, status: event.target.value }),
                  }),
                ),
              ),
              h('div', { className: ROW, style: { justifyContent: 'flex-end', gap: 8 } },
                h(Button, { variant: 'secondary', size: 'sm', onClick: () => setPointForm(null) }, '取消'),
                h(Button, { variant: 'primary', size: 'sm', onClick: () => void savePoint() }, '保存功能点'),
              ),
            ),
          ),
              (() => {
                const raw = matrix.points ?? []
                const query = matrixQuery.trim().toLowerCase()
                const points = raw.filter(point => {
                  if (matrixOnlyOpen === true && point.covered === true) return false
                  if (query === '') return true
                  const hay = [point.id, point.title, ...(point.acceptance ?? []).map(item => String(item.text ?? ''))].join(' ').toLowerCase()
                  return hay.includes(query)
                })
                return h(React.Fragment, null,
                  h('div', { className: 'mb-2 flex min-w-0 flex-wrap items-center gap-2', 'data-matrix-filter': '' },
                    h('div', { className: 'w-64 max-w-full' },
                      h(TextField, { value: matrixQuery, placeholder: '按编号 / 功能点 / 验收条件筛…', 'aria-label': '筛功能点', onChange: event => setMatrixQuery(event.target.value) })),
                    h('label', { className: 'flex cursor-pointer items-center gap-1 text-caption-1-regular text-text-secondary' },
                      h(CheckField, { checked: matrixOnlyOpen, onChange: event => setMatrixOnlyOpen(event.target.checked) }),
                      h('span', {}, '只看未覆盖')),
                    h('span', { className: HINT, 'data-matrix-count': points.length }, `显示 ${points.length} / ${raw.length}`),
                    matrixQuery !== '' || matrixOnlyOpen === true
                      ? h(Button, { variant: 'ghost', size: 'xs', onClick: () => { setMatrixQuery(''); setMatrixOnlyOpen(false) } }, '清除筛选')
                      : null),
                  points.length === 0
                    ? h(EmptyState, { title: '没有匹配的功能点' })
                    : h(Table, { size: 'sm', 'aria-label': '需求追溯矩阵' },
                h(TableHeader, null,
                  /* 表头不放 Checkbox：RAC 的 Table 会把表头里的勾选框当成 selection 列、要求 slot="selection"。
                     放一个纯文本按钮做全选/清空，行内勾选照旧。 */
                  h(TableColumn, { id: 'pick' },
                    h(Button, {
                      variant: 'ghost', size: 'xs',
                      'aria-label': points.length > 0 && points.every(point => selectedPointIds.has(point.id)) ? '清空功能点选择' : '全选功能点',
                      onClick: () => {
                        const all = points.length > 0 && points.every(point => selectedPointIds.has(point.id))
                        setSelectedPointIds(previous => {
                          const nextSet = new Set(previous)
                          for (const point of points) {
                            if (all) nextSet.delete(point.id)
                            else nextSet.add(point.id)
                          }
                          return nextSet
                        })
                      },
                    }, points.length > 0 && points.every(point => selectedPointIds.has(point.id)) ? '清空' : '全选')),
                  h(TableColumn, { id: 'code', isRowHeader: true }, '编号'),
                  h(TableColumn, { id: 'point' }, '功能点'),
                  h(TableColumn, { id: 'covered' }, '覆盖'),
                  h(TableColumn, { id: 'progress' }, '卡与用例'),
                  h(TableColumn, { id: 'actions' }, '操作'),
                ),
                h(TableBody, null,
                      points.map(point => h(TableRow, { key: point.id, id: point.id },
                    h(TableCell, null,
                      // Checkbox 适配层不透传 data-*，钩子挂在外层 span 上（探针按它勾选）。
                      h('span', { 'data-point-pick': point.id },
                        h(CheckField, {
                          checked: selectedPointIds.has(point.id),
                          'aria-label': `选择功能点 ${point.id}`,
                          onChange: event => {
                            const checked = event.target.checked === true
                            setSelectedPointIds(previous => {
                              const next = new Set(previous)
                              if (checked) next.add(point.id)
                              else next.delete(point.id)
                              return next
                            })
                          },
                        }))),
                    h(TableCell, null, h('span', { className: CODE }, point.id)),
                    h(TableCell, { className: 'align-top' },
                      h('b', null, point.title),
                      (() => {
                        const description = String(point.description ?? '')
                        if (description === '') return null
                        const open = openPointIds.has(point.id)
                        const summary = description
                          .replace(/[#*`>|_~]/g, '')
                          .replace(/\s+/g, ' ')
                          .trim()
                          .slice(0, 90)
                        return h(React.Fragment, null,
                          open
                            ? h('div', { className: 'md-content text-text-primary' }, renderMarkdown(point.description))
                            : h('div', { className: 'text-caption-1-regular text-text-tertiary', title: description }, summary + (summary.length >= 90 ? '…' : '')),
                          h(Button, {
                            variant: 'ghost', size: 'xs', className: 'mt-1 self-start',
                            onClick: () => setOpenPointIds((previous) => {
                              const next = new Set(previous)
                              if (next.has(point.id)) next.delete(point.id)
                              else next.add(point.id)
                              return next
                            }),
                          }, open ? '收起' : '全文'),
                        )
                      })(),
                    ),
                    h(TableCell, null,
                      h(Chip, { color: point.covered ? 'lime' : 'gray', 'data-pt': point.covered ? 'covered' : 'open' }, point.covered ? '已覆盖' : '未覆盖'),
                    ),
                    h(TableCell, null,
                      h('div', { className: 'text-caption-1-regular text-text-tertiary' },
                        `卡 ${point.cards.length}${point.cards.length === 0 ? '（还没人做）' : '：' + point.cards.map(card => card.code || card.id).join('、')}`,
                        ` · 用例 ${point.cases.total}（通过 ${point.cases.pass}${point.cases.fail > 0 ? `，失败 ${point.cases.fail}` : ''}${point.cases.pending > 0 ? `，没跑 ${point.cases.pending}` : ''}）`,
                        point.acceptance.length === 0 ? '' : ` · 验收条件 ${point.acceptance.filter(item => item.covered).length}/${point.acceptance.length}`,
                        (point.cases.stale ?? 0) > 0 ? ` · 需复跑 ${point.cases.stale}` : '',
                      ),
                    ),
                    h(TableCell, null,
                      h('div', { className: ACTIONS },
                        h(Button, {
                          variant: 'ghost', size: 'sm',
                          'data-point-edit': point.id,
                          onClick: () => {
                            const editing = pointForm !== null && pointForm.id === point.id
                            if (editing) setPointForm(null)
                            else openPointForm({ ...point, acceptanceText: (point.acceptance ?? []).map(item => item.text).join('\n') })
                          },
                        }, pointForm !== null && pointForm.id === point.id ? '编辑中' : '编辑'),
                        h(Button, { variant: 'destructive', size: 'sm', onClick: () => void removePoint(point.id) }, '删除'),
                      ),
                    ),
                  )),
                ),
              )
            )
              })(),
              (matrix.loose ?? []).length === 0 ? null : h('div', { className: 'mt-3 flex min-w-0 flex-col gap-2 rounded-xl border border-dashed border-separator-border p-3' },
                h('div', { className: HINT, style: { marginBottom: 8 } }, `还有 ${matrix.loose.length} 张卡没归到功能点，选一个挂上去，矩阵才算完整：`),
                matrix.loose.map(card => h('div', { key: card.id, className: 'flex min-w-0 items-center gap-2' },
                  h('span', { className: CODE }, card.code || card.id),
                  h('span', { className: 'min-w-0 flex-1 truncate text-body-2-regular text-text-primary' }, card.title),
                  h(Select, {
                    className: 'w-56',
                    value: '',
                    'aria-label': '把卡挂到功能点',
                    options: [
                      { value: '', label: '挂到…' },
                      ...(matrix.points ?? []).map(point => ({ value: point.id, label: `${point.id} ${point.title}` })),
                    ],
                    onChange: event => { if (event.target.value !== '') void assignLoose(card.id, event.target.value) },
                  }),
                )),
              ),
            ),
          h('div', { className: ROW, style: { gap: 8, marginTop: 12, alignItems: 'center' } },
            h(Button, { variant: 'secondary', size: 'sm', onClick: () => setPointForm(blankPoint()) }, '＋ 加功能点'),
            h(Button, { variant: 'primary', size: 'sm', disabled: splitBusy, onClick: () => void splitPoints() }, splitBusy ? '拆卡中…' : '按未覆盖的功能点拆卡'),
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => { if (current !== null) void loadMatrix(current.id) } }, '刷新矩阵'),
            splitNote === null ? null : h('span', { className: HINT }, splitNote),
            matrixNote === null ? null : h('span', { className: HINT }, matrixNote),
          ),
          h('div', { className: 'grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7' },
            h('div', { className: STATBOX }, h('b', { className: STATVALUE }, `${done}/${tasks.length}`), h('span', { className: LABEL }, '卡已完成')),
            h('div', { className: STATBOX }, h('b', { className: blocked > 0 ? `${STATVALUE} text-text-error-primary` : STATVALUE }, String(blocked)), h('span', { className: LABEL }, '阻塞')),
            h('div', { className: STATBOX }, h('b', { className: bugs > 0 ? `${STATVALUE} text-text-error-primary` : STATVALUE }, String(bugs)), h('span', { className: LABEL }, '未结缺陷')),
            h('div', { className: STATBOX }, h('b', { className: STATVALUE }, `${check.done}/${check.total}`), h('span', { className: LABEL }, '验收清单')),
            h('div', { className: STATBOX }, h('b', { className: STATVALUE }, `${caseAgg.pass}/${caseAgg.total}`), h('span', { className: LABEL }, '用例通过')),
            h('div', { className: STATBOX }, h('b', { className: STATVALUE }, String(artifacts.length)), h('span', { className: LABEL }, '交付物')),
            h('div', { className: STATBOX }, h('b', { className: STATVALUE }, String(mrs.length)), h('span', { className: LABEL }, 'MR')),
          ),
          h('div', { className: SECTION }, `这张需求下的 ${tasks.length} 张卡`),
          tasks.length === 0
            ? h(EmptyState, { title: '还没有挂上来的卡。建卡时选择这条需求，编号会自动分配。' })
            : h('div', { className: 'flex min-w-0 flex-col' }, tasks.map(task => h('div', {
                key: task.id,
                className: `${LISTROW} cursor-pointer hover:bg-background-primary-hover`,
                onClick: () => onOpenTask(task.id),
              },
                h('div', { className: LISTROW_MAIN },
                  h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2 text-body-2-medium text-text-primary' },
                    task.code ? h(Chip, { color: 'gray', className: 'font-mono' }, task.code) : null,
                    h('span', null, task.title),
                  ),
                  h('div', { className: HINT }, `${statusLabel(task.status)}${(() => {
                    const name = task.expert === '' ? '' : ((state.config.experts ?? []).find(entry => entry.id === task.expert)?.name ?? task.expert)
                    return name === '' ? '' : ` · ${name}`
                  })()}${task.dueAt > 0 ? ` · 截止 ${fmtDate(task.dueAt)}` : ''}`),
                ),
                h('div', { className: ACTIONS },
                  task.blocked !== undefined && task.blocked !== null ? h(Chip, { color: 'rose' }, '阻塞') : null,
                  task.type === 'bug' ? h(Chip, { color: 'rose', 'data-sev': task.severity ?? 'p2' }, 'BUG') : null,
                ),
              ))),
          mrs.length > 0 ? h('div', null,
            h('div', { className: SECTION }, '关联 MR'),
            mrs.map(task => h('div', { key: task.id, className: HINT }, `${task.code || task.id} · !${task.gitlabMR.iid} ${task.gitlabMR.title ?? ''}（${task.gitlabMR.state || 'open'}）`)),
          ) : null,
          ),
        )
      })()

return h('div', { className: PAGE, 'data-requirements-page': '' },
        error !== null ? h('div', { className: 'text-caption-1-regular text-text-error-primary', style: { marginBottom: 12 } }, error) : null,
        formPanel,
        /* 工具栏是页面级动作，必须放在两列网格之外：
           以前它和「列表」「明细」一起塞进 grid-cols-[20rem_1fr]（两列三个子元素），
           结果明细被挤到第一列的 20rem 里，正文预览只有 252px 宽。 */
        h('div', { className: 'flex flex-wrap items-center gap-2 pb-2' },
          h('span', { className: HINT }, '新需求从这里开始：'),
          h(Button, {
            variant: 'primary', size: 'sm',
            onClick: () => openNew(),
          }, '新建需求'),
        ),
        h('div', { className: 'grid grid-cols-1 items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]' },
          h('div', { className: 'flex min-w-0 flex-col gap-2', 'data-requirement-list': '' },
            /* 左栏只有 20rem：三件挤一行会折成三行，所以分两行——
               第一行「计数 + 来源筛选」，第二行搜索独占宽度。内联的 190×28 去掉了。 */
            h('div', { className: 'flex items-center justify-between gap-2 text-caption-1-regular text-text-tertiary' },
              h('span', { className: 'shrink-0 tabular-nums' }, `需求 ${visibleRequirements.length}${visibleRequirements.length === requirements.length ? '' : ` / ${requirements.length}`}`),
              h(Button, {
                variant: 'ghost', size: 'sm',
                title: '按来源筛选：全部 / 业务提单 / 内部',
                onClick: () => {
                  const next = reqSource === 'all' ? 'business' : reqSource === 'business' ? 'internal' : 'all'
                  setReqSource(next)
                  try { window.localStorage.setItem('dsh-studio:reqsrc', next) } catch { /* 隐私模式写不了 localStorage，不影响本次筛选 */ }
                },
              }, reqSource === 'all' ? '来源：全部' : reqSource === 'business' ? '来源：业务提单' : '来源：内部'),
            ),
            h(TextField, {
              placeholder: '搜编号 / 标题 / 负责人',
              value: reqQuery,
              onChange: event => setReqQuery(event.target.value),
            }),
            visibleRequirements.length === 0
              ? h(EmptyState, {
                title: requirements.length === 0
                  ? '还没有需求。先建一条——后面所有的卡、用例、缺陷、MR 都会挂在它下面。'
                  : '没有符合筛选的需求：清掉搜索词，或把来源切回「全部」。',
              })
              : visibleRequirements.map(req => {
                  const tasks = tasksOf(req.id)
                  const reqDone = tasks.filter(task => task.status === 'done').length
                  const pct = req.progress?.progress ?? (tasks.length === 0 ? 0 : Math.round((reqDone / tasks.length) * 100))
                  const gate = req.progress?.gate ?? null
                  return h('div', {
                    key: req.id,
                    className: req.id === selected
                      ? 'flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl border border-accent-500 bg-background-secondary-default px-3 py-2'
                      : 'flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl border border-separator-border bg-background-primary-default px-3 py-2 hover:border-border-button-hover',
                    'data-on': req.id === selected ? '1' : '0',
                    'data-requirement-row': req.id,
                    onClick: () => setSelected(req.id),
                  },
                    h('div', { className: 'text-body-2-medium text-text-primary' }, req.title),
                    h('div', { className: 'flex flex-wrap items-center gap-2' },
                      h(Chip, { color: 'gray', className: 'font-mono' }, req.code || '未编号'),
                      req.source === 'business' ? h(Chip, { color: 'blue', 'data-src': 'business', title: [req.requester?.name, req.requester?.dept].filter(Boolean).join(' · ') || '业务提单' }, '业务提单') : null,
                      h(Chip, { color: 'soft', 'data-req': req.status }, REQ_STATUS_LABEL[req.status] ?? req.status),
                      h('span', { className: HINT }, `${reqDone}/${tasks.length} 卡`),
                      gate === null ? null : h('span', { className: HINT, style: { color: gate.ready ? 'var(--color-notification-success-foreground)' : 'var(--color-chart-8-active)' } },
                        gate.ready ? '准出通过' : `还差 ${gate.blockers.length} 项`),
                      req.progress?.coverage !== undefined && req.progress.coverage.total > 0
                        ? h('span', { className: HINT, 'data-coverage': `${req.progress.coverage.executable}/${req.progress.coverage.total}`, title: '可执行用例数 / 总用例数；低于 60% 会拦住签字' },
                          `可执行 ${req.progress.coverage.executable}/${req.progress.coverage.total}`)
                        : null,
                    ),
                    h(ProgressTrack, { percentage: pct, size: 'sm', className: 'mt-1' }),
                  )
                }),
          ),
          h('div', { className: 'flex min-w-0 flex-col rounded-xl border border-separator-border bg-background-primary-default p-4', 'data-requirement-detail': '' }, detail),
        ),
      )
    }
