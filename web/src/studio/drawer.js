/* Card detail drawer: overview, content, plan, artifacts, tests, runs and talk. */

import { expertIconName, statusDot, uiIcon } from './icons.js'
import { ARTIFACT_KINDS, ARTIFACT_KIND_LABEL, ARTIFACT_STATUS, ARTIFACT_STATUS_LABEL, CASE_PRIORITIES, CASE_RESULT_LABEL, CASE_RESULTS, CASE_TIERS, CASE_TIER_FULL, CASE_TIER_HINT, CASE_TIER_LABEL, CASE_TYPES, CASE_TYPE_LABEL, CODING_REVIEW_LABEL, PRIORITY_LABEL, ROLE_LABEL, SEVERITY_LABEL, TYPE_LABEL } from './labels.js'
import { artifactsWithoutBody, buildRoster, cardOwner, caseSummaryOf, checkSummaryOf, commentCountOf, filterRoster, fromDateInput, ownerLabel, toDateInput } from './roster.js'
import { fmtTime } from './format.js'
import { parseSteps } from './cases.js'
import { Button, TreeView, TreeViewItem } from '../boardui/index'
import { EmptyState } from '../boardui/empty-state'
import { ProgressTrack } from '../components/base/progress/progress'
import { archiveFailureNotice, archiveNotice, archivePendingNotice } from './archive-copy.js'
import { productChainRow } from './collab-chain.js'

/* 抽屉版面：token + Tailwind（4px 档）。这一版起不再用手写类：
   小节是圆角卡片，说明文字是 caption-1，字段是「标签 + 控件」两行。
   常量集中在这里，改一处全抽屉一致；探针靠 data-drawer-* 钩子定位，不拿样式类名当判据。 */
const HINT = 'text-caption-1-regular text-text-tertiary'
/* 评审结论的语义色：通过=绿、要求修改=红、待评审=黄。 */
const REVIEW_CHIP_VARIANT = { approved: 'lime', changes_requested: 'rose', pending: 'yellow' }
/* 行内代码块：以前 <code> 没有容器、字号跑出字阶（13px 混在 12px 里），与文件 chip 的语言不一致。 */
const CODE_CHIP = 'shrink-0 rounded bg-background-secondary-default px-1 font-mono text-caption-1-regular text-text-secondary'
const GROW = 'min-w-0 flex-1 basis-40'
const ROW = 'flex min-w-0 flex-wrap items-center gap-2'
const FIELD = 'flex min-w-0 flex-col gap-1'
const LABEL = 'text-caption-1-medium text-text-secondary'
const SECTION = 'flex min-w-0 flex-col gap-3 rounded-xl border border-separator-border bg-background-primary-default p-4'
const SECTION_HEAD = 'flex min-w-0 flex-wrap items-center gap-2'
const SECTION_TITLE = 'text-title-2-semibold text-text-primary'
const SECTION_BODY = 'flex min-w-0 flex-col gap-3'
const ACTIONS = 'flex flex-wrap items-center gap-2'
const PANEL = 'flex min-w-0 flex-col gap-2 rounded-xl border border-separator-border bg-background-primary-default p-3'
/* 头部元素多（徽标 / 身份 / 单测 / 两个按钮）：不给 wrap 的话窄抽屉里 GROW 会被压到 0–8px，
   身份行变成一列一字，整块高度飙到几千像素（视觉验收 640px 实测）。 */
const PANEL_HEAD = 'flex min-w-0 flex-wrap items-start gap-2'
const PANEL_LINE = 'min-w-0 break-words text-body-2-semibold text-text-primary'
const ART_TITLE = 'text-body-2-semibold text-text-primary'
const ART_REF = 'break-words font-mono text-caption-1-regular text-text-secondary'
const ERR_TEXT = 'text-caption-1-regular text-text-error-primary'
const OK_TEXT = 'text-caption-1-regular text-state-success-text'
const WARN_TEXT = 'whitespace-nowrap text-caption-1-semibold text-text-error-primary'
const LIST_LINE = 'flex min-w-0 items-center gap-2 border-b border-separator-border py-2 last:border-b-0'
const NOTE_BOX = 'rounded-lg bg-background-secondary-default p-2 text-caption-1-regular text-text-secondary'
const LINK = 'text-caption-1-regular text-accent-600 hover:underline'
/* 列表行：交付物、用例都用它；左边一条竖线表示结果（失败红、通过绿、未跑灰）。 */
const LIST_ROW = 'flex min-w-0 items-center gap-2 border-b border-l-2 border-separator-border py-2 last:border-b-0 border-l-separator-border'
const CASE_RESULT_RAIL = {
  fail: 'border-l-border-error-default bg-background-tertiary-error',
  pass: 'border-l-state-success-text',
  // pending 与 skip 必须能分开：未跑=黄，跳过=中性灰
  pending: 'border-l-status-yellow-text',
  skip: 'border-l-separator-border-strong',
}
const CASE_RESULT_CHIP = { pass: 'lime', fail: 'rose', pending: 'yellow', skip: 'neutral' }
const COMMENT_ROLE_RAIL = {
  product: 'border-l-status-blue-text',
  architect: 'border-l-status-purple-text',
  dev: 'border-l-status-lime-text',
  qa: 'border-l-status-yellow-text',
}
const EMPTY_BOX = 'flex min-w-0 flex-col gap-1 rounded-xl border border-separator-border bg-background-secondary-default p-3'

const DESIGN_LABEL = { approved: '已通过', pending: '待评审', changes_requested: '要改' }

/* 代码改动的文件树：git 只给扁平路径，这里拼成目录树，抽屉用 BoardUI TreeView 展示。
   目录在前、同类按名字排序；节点 id 用完整路径（选中状态与 DOM 钩子都靠它）。 */
const DIFF_CHANGE_LABEL = { added: '新增', modified: '修改', deleted: '删除', renamed: '改名', copied: '复制' }
const DIFF_CHANGE_CLASS = {
  added: 'text-state-success-text',
  modified: 'text-accent-600',
  deleted: 'text-text-error-primary',
  renamed: 'text-status-purple-text',
  copied: 'text-status-purple-text',
}

function buildDiffTree(files) {
  const root = []
  for (const file of files) {
    const path = String(file.path ?? '')
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0) continue
    let level = root
    let prefix = ''
    for (const segment of segments.slice(0, -1)) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`
      let node = level.find(item => item.kind === 'dir' && item.name === segment)
      if (node === undefined) {
        node = { kind: 'dir', id: prefix, name: segment, path: prefix, children: [] }
        level.push(node)
      }
      level = node.children
    }
    level.push({ kind: 'file', id: path, name: segments[segments.length - 1], path, file })
  }
  const sort = nodes => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    for (const node of nodes) if (node.kind === 'dir') sort(node.children)
  }
  sort(root)
  return root
}

/** 默认把所有目录展开：改动文件大多两三层，收着反而要多点好几下。 */
function diffDirIds(nodes, out = []) {
  for (const node of nodes) {
    if (node.kind !== 'dir') continue
    out.push(node.id)
    diffDirIds(node.children, out)
  }
  return out
}

/* 交接契约五段式：顺序与 src/host/handoff.js 的 HANDOFF_FIELDS 一致。
   标签在这里写死是为了不把 host 模块 import 进浏览器包（会多带一份纯函数）。 */
const HANDOFF_FORM = [
  ['decision', '决策', '这一棒定下来的选择与理由'],
  ['assumptions', '假设', '依赖什么；不成立会怎样'],
  ['openQuestions', '未决', '还没定的问题 / 要谁拍板'],
  ['risks', '风险', '最可能出问题的地方与缓解'],
  ['impactScope', '影响面', '模块 / 接口 / 数据 / 用户'],
]

export function createDrawer({ h, React, api, kit, currentUser, renderMarkdown, tipOf, tipLabel, confirmDialog, promptDialog, TextField, TextAreaField, ChipField, CheckField, SelectField, MdField, MentionPicker, toast }) {
/* 小节 = 圆角卡片：标题行 + 内容。pane 决定它属于哪个页签，current 是当前页签。
   这两个组件放在工厂作用域里（不是 Drawer 内部）：组件身份必须跨渲染稳定，
   否则每次轮询/输入都会得到一个新类型，React 整块卸载重挂——输入框会一个字丢一次焦点。 */
function Section({ pane, current, id, children, ...rest }) {
  return h('section', {
    ...rest,
    className: SECTION,
    style: pane === current ? undefined : { display: 'none' },
    'data-drawer-section': id ?? pane,
  }, children)
}
/* 标题行：第一段是标题，其余（说明文字、动作按钮）原样跟在后面 */
function SectionHead({ children }) {
  const list = React.Children.toArray(children).filter(item => item !== null && item !== undefined && item !== '')
  if (list.length === 0) return null
  return h('div', { className: SECTION_HEAD }, h('div', { className: SECTION_TITLE }, list[0]), list.slice(1))
}

function Drawer({ task, state, onClose, onChanged, onOpenTask = null }) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  /* 状态历史全文（/state 只带最近 12 条）：null = 未加载，直接用 task.history。 */
  /* 评审意见默认收起（主行动常显）：意见是可选补充，不该占着第一屏。 */
  const [noteOpen, setNoteOpen] = React.useState(false)
  const [historyAll, setHistoryAll] = React.useState(null)
  const [historyBusy, setHistoryBusy] = React.useState(false)
  const loadFullHistory = async () => {
    setHistoryBusy(true)
    try {
      const out = await api('/task/parts', { id: task.id })
      if (Array.isArray(out.history)) setHistoryAll(out.history)
    } catch (cause) { toast(cause instanceof Error ? cause.message : String(cause)) } finally { setHistoryBusy(false) }
  }
  const [comment, setComment] = React.useState('')
  const [notice, setNotice] = React.useState(null)
  /* 反馈不能只写在「讨论」页底部：在计划 / 设计 / 交付物 / 测试页点保存或推进，
     成功与失败都要当场看得见，否则就是「点了没反应」。error / notice 一变化就补一条
     轻提示；讨论页底部仍保留原位文案（贴图/复制上下文时还在）。 */
  const lastToast = React.useRef({ error: null, notice: null })
  React.useEffect(() => {
    if (error === null) { lastToast.current.error = null; return }
    if (lastToast.current.error === error) return
    lastToast.current.error = error
    if (typeof toast === 'function') toast(String(error), 'error')
  }, [error])
  React.useEffect(() => {
    if (notice === null) { lastToast.current.notice = null; return }
    if (lastToast.current.notice === notice) return
    lastToast.current.notice = notice
    if (typeof toast === 'function') toast(String(notice), 'success')
  }, [notice])
  const [picked, setPicked] = React.useState('')
  /* 「马上处理」可以带一句开场白（拼进提示词）；issue #148 评论：以前卡上派单没法交代这次要干什么。 */
  const [dispatchNote, setDispatchNote] = React.useState('')
  /* 这次派单实际会用哪套权限（沙箱 + 提权审批）。只对 studio-* 派单会话生效，
     手动新开的会话仍归 DSH 自己的权限档位——写清楚，免得上一次「设置里选了全权限
     为什么还弹审批」的误会再发生。 */
  const [policy, setPolicy] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    void api('/agents/policy').then(out => { if (alive) setPolicy(out ?? null) }).catch(() => {})
    return () => { alive = false }
  }, [task.id, task.dispatch?.state])
  const bodyRef = React.useRef(null)
  /* 键盘可达（WCAG 2.1.1 / 2.4.3）：
     - Esc 关抽屉：抽屉占满右侧，没有它只能去点右上角的小 ×
     - 打开时把焦点移进抽屉，Tab 只在抽屉内循环（aria-modal 的语义要配焦点圈，
       否则键盘用户一路 Tab 就跑到下面被遮住的页面里去了）
     - 关闭后把焦点还给打开它的那个元素 */
  const drawerRef = React.useRef(null)
  /* onClose 每次父组件渲染都是新的内联函数：effect 依赖它就会每次轮询都重跑，
     把正在写评论的焦点抢回抽屉容器（每 15 秒一次）。用 ref 拿最新的，effect 只跑一次。 */
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose
  React.useEffect(() => {
    const opener = typeof document === 'undefined' ? null : document.activeElement
    const node = drawerRef.current
    if (node !== null) node.focus()
    const focusables = () => {
      if (node === null) return []
      return [...node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.disabled !== true && el.offsetParent !== null)
    }
    const onKey = event => {
      if (event.key === 'Escape') { onCloseRef.current(); return }
      if (event.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) { event.preventDefault(); return }
      const first = list[0]
      const last = list[list.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (opener !== null && typeof opener.focus === 'function') opener.focus()
    }
  }, [])
  const [plan, setPlan] = React.useState({
    project: task.project ?? '',
    iteration: task.iteration ?? '',
    service: task.service ?? '',
    owner: task.owner ?? '',
    due: toDateInput(task.dueAt),
    releaseId: task.releaseId ?? '',
    /* 类型 / 优先级 / 父任务以前只能建卡时定：紧急度填错、缺陷挂错父卡就只能删了重建。 */
    type: task.type ?? 'requirement',
    priority: task.priority ?? 'normal',
    parent: task.parent ?? '',
  })
  const [newItem, setNewItem] = React.useState('')
  const [artifact, setArtifact] = React.useState({ kind: 'doc', title: '', ref: '', content: '' })
  const [artEdit, setArtEdit] = React.useState(null)
  // 交付物多了先筛再找：按标题 / 类型 / 链接。
  const [artifactQuery, setArtifactQuery] = React.useState('')
  const [artRead, setArtRead] = React.useState(null)
  // 截图预览：只取 data URL，不把磁盘路径变成静态资源
  const [imageOf, setImageOf] = React.useState('')
  const [imageData, setImageData] = React.useState(null)
  const [imageError, setImageError] = React.useState(null)
  // 正文不随轮询下发（一条能到几十 KB），点「阅读 / 正文」时才单独取，取过的缓存在这里。
  const [artBodies, setArtBodies] = React.useState({})
  // 评论正文同样不随轮询下发（一条讨论动辄几百字），抽屉打开时按卡取一次。
  const [commentList, setCommentList] = React.useState(null)
  /* 评论编辑：后端 /task/comment 支持 update/remove 并留历史，界面之前没有入口。 */
  const [commentEdit, setCommentEdit] = React.useState(null)
  // 用例与验收清单的正文同样按需取，轮询只给计数。
  const [parts, setParts] = React.useState(null)
  React.useEffect(() => { setArtBodies({}); setArtRead(null); setArtEdit(null); setArtifactQuery('') }, [task.id])
  // 新用例的 pointId 默认跟卡走：一个功能点通常多条用例，别让人每条都选一次（issue #11 可发现性）
  const [newCase, setNewCase] = React.useState({ title: '', expected: '', steps: '', stepsText: '', type: 'functional', tier: '', priority: 'p2', preconditions: '', pointId: task.pointId ?? '' })
  const [caseRun, setCaseRun] = React.useState({ busy: false, note: '' })
  const [caseGen, setCaseGen] = React.useState({ busy: false, note: '' })
  /* 用例明细默认收起：接口/响应/步骤/功能点/记录一展开就是十几行，35 条用例滚不动。 */
  const [expandedCaseIds, setExpandedCaseIds] = React.useState(() => new Set())
  /* 用例筛选：默认失败→未跑→跳过→通过，和用例库页一致。 */
  const [caseFilter, setCaseFilter] = React.useState('all')
  const [caseQuery, setCaseQuery] = React.useState('')
  /* 改定义：一个表单，不再连弹 4 个 prompt。 */
  const [caseEdit, setCaseEdit] = React.useState(null)
  const [caseBugMap, setCaseBugMap] = React.useState({})
  const [codingDraft, setCodingDraft] = React.useState(null)
  const [reviewNote, setReviewNote] = React.useState('')
  const coding = task.coding ?? null
  // 设计多稿：定案（chosenId）与评审（status）分开——"这几稿都行"不等于"选了哪一稿"。
  // 必须在 tabs 之前定义：上面那个页签的 count 要读它（放后面就是 TDZ）。
  const designDrafts = Array.isArray(task.design?.drafts) ? task.design.drafts : []
  const chosenDraft = designDrafts.find(item => item.id === task.design?.chosenId) ?? null
  /* 设计评审意见：驳回要写清改什么，通过时也允许留一句结论。 */
  const [designNote, setDesignNote] = React.useState(String(task.design?.note ?? ''))
  const worktree = task.worktree ?? null
  const [worktreeMsg, setWorktreeMsg] = React.useState('')
  const [verify, setVerify] = React.useState({ busy: false, line: '', ok: null })
  /* 代码改动：直接读仓库里的 git diff（只读路由，不推 revision）。
     切到「执行记录」页签时按需加载；文件逐个折叠，点开看逐行 patch —— 人不用再自己去仓库敲 git diff。 */
  const [diffView, setDiffView] = React.useState(null)
  const [diffBusy, setDiffBusy] = React.useState(false)
  const [diffError, setDiffError] = React.useState(null)
  // 文件树里选中的那个文件：默认选第一个有改动的文件，打开就能看到内容。
  const [diffPath, setDiffPath] = React.useState('')
  // 「看全部 / 看某一次提交」与按路径筛文件。
  const [diffCommit, setDiffCommit] = React.useState('')
  const [diffQuery, setDiffQuery] = React.useState('')
  // 右边内容区看「改动（patch）」还是「全文（工作树里的文件）」。
  const [diffMode, setDiffMode] = React.useState('diff')
  const [fileView, setFileView] = React.useState(null)
  const loadFile = async path => {
    setFileView({ path, busy: true, data: null, error: null })
    try {
      const out = await api('/task/file', { id: task.id, path })
      setFileView({ path, busy: false, data: out ?? null, error: null })
    } catch (cause) {
      setFileView({ path, busy: false, data: null, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  const selectDiffFile = path => {
    setDiffPath(path)
    setFileView(null)
    if (diffMode === 'file' && path !== '') void loadFile(path)
  }
  /* 复制路径 / 复制内容：非安全上下文（http 的 .218）里 navigator.clipboard 不可用，退回 execCommand。 */
  const copyPlain = async (text, label) => {
    const value = String(text ?? '')
    if (value === '') { setNotice('没有可复制的内容'); return }
    let ok = false
    try { await navigator.clipboard.writeText(value); ok = true } catch { /* 走下面的兜底 */ }
    if (!ok) {
      try {
        const area = document.createElement('textarea')
        area.value = value
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        ok = document.execCommand('copy')
        area.remove()
      } catch { ok = false }
    }
    setNotice(ok ? `已复制${label}（${value.length} 字）` : `复制失败：浏览器不允许写剪贴板，手动选中${label}吧`)
  }
  const loadDiff = async (commit = diffCommit) => {
    if (diffBusy) return
    setDiffBusy(true)
    setDiffError(null)
    try {
      const out = await api('/task/diff', { id: task.id, ...(commit === '' ? {} : { commit }) })
      setDiffView(out ?? null)
      const files = Array.isArray(out?.files) ? out.files : []
      setDiffPath(current => (files.some(item => item.path === current) ? current : (files[0]?.path ?? '')))
    } catch (cause) {
      setDiffError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDiffBusy(false)
    }
  }
  React.useEffect(() => {
    setDiffView(null)
    setDiffPath('')
    setDiffError(null)
    setDiffMode('diff')
    setFileView(null)
    setDiffCommit('')
    setDiffQuery('')
  }, [task.id])
  // 项目检查：跑本地质量命令（npm run check 之类），结果由服务端写回卡片。
  const [qualityRun, setQualityRun] = React.useState({ busy: false, line: '' })
  const quality = task.quality ?? null
  // 技能沉淀：把这张卡的证据汇总成一条技能草稿（默认停用，人看过再启用）。
  const [mine, setMine] = React.useState({ busy: false, line: '' })
  // 合并门禁：把「能不能合」发布成 GitLab 提交状态。
  const [mergeRun, setMergeRun] = React.useState({ busy: false, line: '' })
  const mergeGate = task.mergeGate ?? null
  const caseSum = caseSummaryOf(task)
  const checkSum = checkSummaryOf(task)
  const cases = parts !== null && Array.isArray(parts.cases) ? parts.cases : (Array.isArray(task.cases) ? task.cases : [])
  // 需求文档改版后，之前通过过的用例要复跑（服务端按文档更新时间算好 stale，界面只显示）
  const staleCases = cases.filter(item => item.stale === true).length
  /* 三层测试：服务端算好的分层进度与缺口（parts.plan），以及最近几次执行批次。
     界面不自己重算一遍口径 —— 门禁读的也是服务端这一份。 */
  const testPlanTiers = parts !== null && parts.plan !== null && parts.plan !== undefined && Array.isArray(parts.plan.tiers) ? parts.plan.tiers : []
  const testPlanGaps = parts !== null && parts.plan !== null && parts.plan !== undefined && Array.isArray(parts.plan.gaps) ? parts.plan.gaps : []
  const testRuns = parts !== null && Array.isArray(parts.testRuns) ? parts.testRuns : (Array.isArray(task.testRuns) ? task.testRuns : [])
  const [gate, setGate] = React.useState(null)
  const [gateNote, setGateNote] = React.useState('')
  const casePass = caseSum.pass
  const caseFail = caseSum.fail
  const caseSkip = cases.filter(item => item.result === 'skip').length
  const casePending = Math.max(0, caseSum.total - casePass - caseFail - caseSkip)
  const caseRank = { fail: 0, pending: 1, skip: 2, pass: 3 }
  const caseQueryText = caseQuery.trim().toLowerCase()
  const visibleCases = cases
    .filter(item => {
      if (caseFilter !== 'all' && item.result !== caseFilter) return false
      if (caseQueryText === '') return true
      return [item.title, item.expected, item.note].join(' ').toLowerCase().includes(caseQueryText)
    })
    .sort((a, b) => (caseRank[a.result] ?? 9) - (caseRank[b.result] ?? 9))
  const caseSummary = caseSum.total === 0
    ? ''
    : `${caseSum.total} 条 · 通过 ${casePass} · 不通过 ${caseFail}${casePending > 0 ? ` · 未跑 ${casePending}` : ''}${caseSkip > 0 ? ` · 跳过 ${caseSkip}` : ''}`
  const checklist = parts !== null && Array.isArray(parts.checklist) ? parts.checklist : (Array.isArray(task.checklist) ? task.checklist : [])
  const doneCount = checkSum.done
  const artifacts = task.artifacts ?? []
  const artifactQueryText = artifactQuery.trim().toLowerCase()
  const visibleArtifacts = artifactQueryText === ''
    ? artifacts
    : artifacts.filter(item => [item.title, item.ref, ARTIFACT_KIND_LABEL[item.kind] ?? item.kind].join(' ').toLowerCase().includes(artifactQueryText))
  // 轮询给的只有 contentLength；正文要么已经取过（artBodies），要么还在路上。
  const artifactBody = (item) => (artBodies[item.id] !== undefined ? artBodies[item.id] : String(item.content ?? ''))
  const artifactHasBody = (item) => (typeof item.contentLength === 'number' ? item.contentLength > 0 : String(item.content ?? '').trim() !== '')
  const loadArtifactBody = async (item) => {
    const cached = artBodies[item.id]
    if (cached !== undefined) return cached
    const json = await api('/task/artifact', { id: task.id, action: 'get', artifactId: item.id })
    const content = String(json?.artifact?.content ?? '')
    setArtBodies(previous => ({ ...previous, [item.id]: content }))
    return content
  }
  const readArtifact = async (item) => {
    if (artRead === item.id) { setArtRead(null); return }
    setArtRead(item.id)
    if (artBodies[item.id] !== undefined) return
    try { await loadArtifactBody(item) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setArtRead(null) }
  }
  const previewArtifact = async (item) => {
    if (imageOf === item.id) { setImageOf(''); return }
    setImageOf(item.id); setImageData(null); setImageError(null)
    try {
      const out = await api('/task/artifact/image', { id: task.id, artifactId: item.id })
      if (out?.ok === true) setImageData(String(out.dataUrl ?? ''))
      else setImageError(String(out?.error ?? '读不到这张图'))
    } catch (cause) { setImageError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const editArtifact = async (item) => {
    if (artEdit !== null && artEdit.id === item.id) { setArtEdit(null); return }
    try { setArtEdit({ id: item.id, content: await loadArtifactBody(item) }) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const commentTotal = commentCountOf(task)
  const comments = commentList ?? (Array.isArray(task.comments) ? task.comments : [])
  // 条数变了（比如刚发了一条）就再取一次；没评论的卡不发请求。
  React.useEffect(() => {
    if (commentTotal === 0) { setCommentList([]); return undefined }
    let alive = true
    void api('/task/comments', { id: task.id }).then(json => {
      if (alive) setCommentList(Array.isArray(json?.comments) ? json.comments : [])
    }).catch(() => { if (alive) setCommentList([]) })
    return () => { alive = false }
  }, [task.id, commentTotal, task.updatedAt])
  // 用例、清单、执行批次与测试计划正文：抽屉打开（或卡片有任何写入）时取一次。
  // 以前空卡直接跳过请求，但「零用例 + 已声明某层不适用」也是要展示的状态，所以不再短路。
  React.useEffect(() => {
    let alive = true
    void api('/task/parts', { id: task.id }).then(json => {
      if (!alive) return
      setParts({
        cases: Array.isArray(json?.cases) ? json.cases : [],
        checklist: Array.isArray(json?.checklist) ? json.checklist : [],
        testRuns: Array.isArray(json?.testRuns) ? json.testRuns : [],
        testPlan: json?.testPlan ?? null,
        plan: json?.plan ?? null,
      })
    }).catch(() => { if (alive) setParts({ cases: [], checklist: [], testRuns: [], testPlan: null, plan: null }) })
    return () => { alive = false }
  }, [task.id, task.updatedAt, caseSum.total, caseSum.pass, caseSum.fail, checkSum.total, checkSum.done])
  /* 打开卡默认落在最该干活的页：待测试 → 测试，待评审 → 执行记录，其余回概览。 */
  const initialPaneFor = status => status === 'test' ? 'test' : status === 'review' ? 'coding' : status === 'accept' ? 'test' : 'overview'
  const [pane, setPane] = React.useState(() => initialPaneFor(task.status))
  React.useEffect(() => { setPane(initialPaneFor(task.status)) }, [task.id])
  /* 换一张卡就把评审意见换成那张卡自己的（抽屉是 key 重建的兜底之外的保险）。 */
  React.useEffect(() => { setDesignNote(String(task.design?.note ?? '')) }, [task.id])
  // 切页签时把内容滚回顶部，否则从长页面切到「讨论」会停在中间，看起来像只显示了半截。
  React.useEffect(() => {
    const node = bodyRef.current
    if (node !== null) node.scrollTop = 0
  }, [pane, task.id])
  /* 第一次切到「执行记录」时自动读一次 git diff：否则要人先点一下「读取」才知道有这个功能。
     已读过 / 正在读 / 上次报错都跳过，别每次轮询都去敲一遍 git；刷新有按钮。 */
  React.useEffect(() => {
    if (pane !== 'coding') return
    if (diffView !== null || diffBusy || diffError !== null) return
    void loadDiff()
  }, [pane, task.id])
  const tabs = [
    { id: 'overview', label: '概览', hint: '标题、状态、负责人、阻塞原因与关键时间' },
    { id: 'content', label: '内容', hint: '需求正文与验收标准，支持 Markdown' },
    { id: 'plan', label: '计划', hint: '项目、迭代、服务、挂哪条需求、优先级' },
    { id: 'handoff', label: '交接', count: task.handoff !== null && task.handoff !== undefined ? '✓' : '', hint: '决策 / 假设 / 未决 / 风险 / 影响面；派单提示词先读它' },
    { id: 'design', label: '设计', count: designDrafts.length > 0 ? designDrafts.length : '', hint: '多稿对比与定案' },
    { id: 'deliver', label: '交付物', count: artifacts.length > 0 ? artifacts.length : '', hint: '文档 / MR / 用例 / 报告；空的交付物会被准出拦下' },
    { id: 'test', label: '测试', count: caseSum.total > 0 ? `${casePass}/${caseSum.total}` : (checkSum.total > 0 ? `${doneCount}/${checkSum.total}` : ''), hint: '三层测试进度（单元/集成/端到端）、验收清单与执行记录；失败用例自动开缺陷' },
    { id: 'coding', label: '执行记录', count: coding === null ? '' : (coding.review?.status === 'approved' ? '✓ 已评审' : ''), hint: '代码改动（逐行 diff）、AI 的分支与提交、改动文件、评审结论；可以「核对代码事实」' },
    { id: 'discuss', label: '讨论', count: commentTotal > 0 ? commentTotal : '', hint: '评论；在评论里 @ 专家或专家团即派单' },
  ]
  const [draft, setDraft] = React.useState({ title: task.title, requirement: task.requirement, gitlabIssue: task.gitlabIssue, gitlabMR: task.gitlabMR?.url ?? '', pointId: task.pointId ?? '' })
  /* 交接契约：从卡上已有的五段初始化；清空全部字段保存 = 删除契约（后端把全空归一成 null）。 */
  const [handoff, setHandoff] = React.useState(() => {
    const saved = task.handoff ?? {}
    return Object.fromEntries(HANDOFF_FORM.map(([key]) => [key, String(saved[key] ?? '')]))
  })

  const push = async (patch) => {
    setBusy(true); setError(null)
    try {
      await api('/task/update', { id: task.id, patch, ...(Number.isInteger(Number(task.version)) ? { ifVersion: Number(task.version) } : {}) })
      await onChanged()
    } catch (cause) {
      if (cause?.code === 'version_conflict') {
        /* 乐观锁：卡片在我编辑期间被 AI/同事改过。刷新拿到最新版，让人重做这次修改，
           而不是把对方刚写的内容静默覆盖掉。 */
        setError('这张卡刚被改过（你看到的是旧版本）：已刷新，请重做这次修改')
        await onChanged()
        return
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }
  /* 推进到某列：门禁拦住时给「写原因强推」的出口，与看板拖拽同一套流程。
     以前这里只 setError，而抽屉的错误只在「讨论」页可见，看起来就是按钮没反应。 */
  const advanceTo = async (status, role) => {
    setBusy(true); setError(null); setNotice(null)
    const guard = Number.isInteger(Number(task.version)) ? { ifVersion: Number(task.version) } : {}
    try {
      await api('/task/update', { id: task.id, patch: { status, role }, ...guard })
      await onChanged()
    } catch (cause) {
      if (cause?.code === 'version_conflict') {
        setError('这张卡刚被改过（你看到的是旧版本）：已刷新，请重做这次推进')
        await onChanged()
        return
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!/准出没过|进开发被拦|进测试被拦/.test(message)) { setError(message); return }
      const reason = await promptDialog(`${message}\n\n确实要强推就写原因（会计入 override 统计）：`, { title: '绕过门禁', okText: '强推' })
      if (reason === null || String(reason).trim() === '') return
      try {
        await api('/task/update', { id: task.id, patch: { status, role, override: String(reason).trim() }, ...guard })
        setNotice('已强推，原因已记录')
        await onChanged()
      } catch (again) { setError(again instanceof Error ? again.message : String(again)) }
    } finally { setBusy(false) }
  }
  /* 交接契约单独走一次 /task/update：五段是一个整体，走 push 的 patch 包装也行，
     但这里要给出「保存成功」的明确反馈——专家写契约时最怕点了没反应。 */
  const saveHandoff = async () => {
    setBusy(true); setError(null); setNotice(null)
    try {
      await api('/task/update', { id: task.id, handoff: { ...handoff, by: currentUser() }, ...(Number.isInteger(Number(task.version)) ? { ifVersion: Number(task.version) } : {}) })
      setNotice('交接契约已保存：下一棒派单时会先读它')
      await onChanged()
    } catch (cause) {
      if (cause?.code === 'version_conflict') {
        setError('这张卡刚被改过（你看到的是旧版本）：已刷新，请重新填写交接契约')
        await onChanged()
        return
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }
  // AI 失败后：清掉失败计数与自动挂的阻塞，让派单器重新接手。
  const retryAgent = async () => {
    setBusy(true); setError(null); setNotice(null)
    try {
      await api('/task/agent/retry', { id: task.id, by: currentUser() })
      setNotice('已清掉失败计数，下一轮派单会重新接手')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const checkGate = async () => {
    setBusy(true); setError(null)
    try {
      const out = await api('/task/gate', { id: task.id })
      setGate(out.gate)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const signOff = async (action) => {
    setBusy(true); setError(null)
    try {
      const out = await api('/task/signoff', { id: task.id, action, note: gateNote, by: currentUser() })
      setGateNote('')
      setGate(out.gate ?? null)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const send = async () => {        if (comment.trim().length === 0) return
    setBusy(true); setError(null)
    try {
      const out = await api('/task/comment', { id: task.id, body: comment, author: currentUser(), kind: 'human' })
      const told = (out.mentions ?? []).map(mention => mention.label ?? mention.id)
      /* 点了名不等于派上了：并发已满、专家停用、团里没成员都会在 dispatched 里带 failed。
         以前只报「已通知」，看上去像已经开工。 */
      const failed = (Array.isArray(out.dispatched) ? out.dispatched : [])
        .map(item => String(item))
        .filter(item => item.includes('failed:'))
        .map(item => item.split('failed:').slice(1).join('failed:').trim())
      setComment('')
      if (told.length > 0) setNotice(`已通知 ${told.join('、')}`)
      if (failed.length > 0) setError(`评论已发出，但派单没起来：${failed.join('；')}`)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const startCommentEdit = item => setCommentEdit({ id: item.id, body: String(item.body ?? '') })
  const saveCommentEdit = async () => {
    if (commentEdit === null) return
    const body = String(commentEdit.body ?? '').trim()
    if (body === '') { setError('评论不能为空'); return }
    setBusy(true); setError(null)
    try {
      await api('/task/comment', { id: task.id, action: 'update', commentId: commentEdit.id, body })
      setCommentEdit(null)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const removeComment = async item => {
    if (!(await confirmDialog('删除这条评论？删掉后不可恢复（历史里保留旧版）。', { title: '删除评论', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null)
    try {
      await api('/task/comment', { id: task.id, action: 'remove', commentId: item.id })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const mention = name => setComment(previous => previous.replace(/\s*$/, previous.length === 0 ? '' : ' ') + `@${name} `)
  // 打「@」就地补全：只在光标前最后一个词是 @开头时给建议，选中后替换掉这半截词。
  const [picker, setPicker] = React.useState(null)
  const [active, setActive] = React.useState(0)
  const roster = React.useMemo(() => buildRoster(state.config), [state.config])
  /* 与 @ 弹层用同一份名单：弹层只显示专家 / 专家团（角色位是给 AI 按角色派单的兜底），
     输入框里的回车也必须按同一份算。以前这里用的是全量 roster，角色位排在最前，
     打「@」直接回车会插入「角色 · 产品经理」—— 文本发出去谁也不会被派单。 */
  const hits = picker === null ? [] : filterRoster(roster, picker.query).filter(item => item.group !== '角色位')
  const refreshPicker = (value, caret) => {
    const head = value.slice(0, caret)
    const hit = /@([^\s@]{0,24})$/.exec(head)
    if (hit === null) { setPicker(previous => (previous !== null && previous.inline ? null : previous)); return }
    setPicker({ query: hit[1], from: caret - hit[0].length, inline: true })
    setActive(0)
  }
  const pick = name => {
    const current = picker
    if (current !== null && current.inline && current.from !== null) {
      const from = current.from
      setComment(value => value.slice(0, from) + `@${name} `)
    } else {
      mention(name)
    }
    setPicker(null)
  }
  const remove = async () => {
    if (!(await confirmDialog(`删除任务「${task.title}」？`, { title: '删除任务', danger: true, okText: '删除' }))) return
    setBusy(true)
    try { await api('/task/delete', { id: task.id }); onClose(); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const runAgent = async () => {
    setBusy(true); setError(null)
    try {
      // 下拉里专家团的值带 `team:` 前缀（专家 id 与团 id 可能同名），发出去时去掉。
      const target = picked.startsWith('team:') ? picked.slice('team:'.length) : (picked.startsWith('expert:') ? picked.slice('expert:'.length) : picked)
      await api('/agents/run', { id: task.id, expert: target, instruction: dispatchNote.trim() })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const blocked = task.blocked ?? null
  const markBlocked = async () => {
    const reason = await promptDialog('卡在哪了？（写清楚，之后要据此决定怎么继续）', { title: '标记阻塞', defaultValue: blocked?.reason ?? '', placeholder: '比如：等支付网关联调账号' })
    if (reason === null) return
    if (reason.trim() === '') { setError('阻塞原因至少写一句话'); return }
    setBusy(true); setError(null); setNotice(null)
    try { await api('/task/block', { id: task.id, reason: reason.trim() }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const resolveBlocked = async (action, expert) => {
    if (action === 'advance' && !(await confirmDialog('解除阻塞并把卡推到下一列？下一列的 AI 会立刻接手。', { title: '解除阻塞', okText: '解除并推进' }))) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await api('/task/unblock', { id: task.id, action, expert })
      setNotice(action === 'advance'
        ? '已解除阻塞，推进到下一列'
        : action === 'assign'
          ? '已解除阻塞，已交给指定专家'
          : action === 'clear'
            ? '已解除阻塞（暂不派单）'
            : '已解除阻塞，已交回本列负责人')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const stopAgent = async () => {
    setBusy(true); setError(null)
    try { await api('/agents/stop', { id: task.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const savePlan = async () => {
    await push({
      project: plan.project,
      iteration: plan.project === '' ? '' : plan.iteration,
      service: plan.project === '' ? '' : (plan.service ?? ''),
      owner: plan.owner,
      dueAt: fromDateInput(plan.due),
      releaseId: plan.releaseId ?? '',
      type: plan.type,
      priority: plan.priority,
      parent: plan.parent ?? '',
    })
  }
  const addChecklist = async () => {
    const text = newItem.trim()
    if (text === '') return
    setBusy(true); setError(null)
    try { await api('/task/checklist', { id: task.id, action: 'add', text }); setNewItem(''); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const toggleChecklist = async (item) => {
    setBusy(true); setError(null)
    try {
      await api('/task/checklist', { id: task.id, action: 'toggle', itemId: item.id, done: !item.done, note: item.done ? '' : undefined })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const removeChecklist = async (item) => {
    /* 清单条目上常挂着勾选证据（命令输出、文件路径），点错「×」就没了；同文件里删卡/删用例/删评论都先确认。 */
    const label = String(item.text ?? '').slice(0, 40)
    if (!(await confirmDialog(`删除这条验收清单？${label === '' ? '' : `「${label}」`}${item.note ? '它上面的证据也会一起没掉。' : ''}`, { title: '删除清单条目', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null)
    try { await api('/task/checklist', { id: task.id, action: 'remove', itemId: item.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  // shell 用例：两步录入（命令 + 期望输出），断言退出码 0。真跑要服务端打开 allowShell。
  // 数据库用例：库文件 + SQL + 期望值，三步录入。真跑要服务端打开 allowDb。
  const addDbCase = async () => {
    const file = await promptDialog('SQLite 库文件路径', { title: '加一条数据库用例', defaultValue: '' })
    if (file === null || String(file).trim() === '') return
    const sql = await promptDialog('SQL 语句（返回的行用来断言）', { title: '加一条数据库用例', defaultValue: 'select 1 as n' })
    if (sql === null || String(sql).trim() === '') return
    const column = await promptDialog('断言首行的哪一列（留空就只看能不能执行）', { title: '加一条数据库用例', defaultValue: 'n' })
    if (column === null) return
    const expect = await promptDialog('这一列的期望值（可留空）', { title: '加一条数据库用例', defaultValue: '' })
    if (expect === null) return
    setBusy(true); setError(null)
    try {
      const spec = { file: String(file).trim(), sql: String(sql).trim() }
      const expectText = String(expect ?? '').trim()
      const columnName = String(column ?? '').trim()
      if (expectText !== '' && columnName !== '') { spec.expectColumn = columnName; spec.expectValue = expectText }
      const title = ('db: ' + spec.sql).slice(0, 60)
      const server = String(column ?? 'n').trim() || 'n'
      await api('/task/case', { id: task.id, action: 'add', cases: [{ title: title, expected: expectText === '' ? '能执行' : (server + ' = ' + expectText), tier: 'integration', db: spec }] })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const addShellCase = async (tier = '') => {
    const command = await promptDialog('shell 命令（断言退出码 0）', { title: tier === 'unit' ? '加一条单元测试用例' : '加一条 shell 用例', defaultValue: '' })
    if (command === null || String(command).trim() === '') return
    const expect = await promptDialog('期望输出里包含什么（可留空）', { title: '加一条 shell 用例', defaultValue: '' })
    if (expect === null) return
    setBusy(true); setError(null)
    try {
      const expectText = String(expect ?? '').trim()
      const item = {
        title: ('shell: ' + String(command).trim()).slice(0, 60),
        expected: expectText === '' ? '退出码 0' : ('退出码 0 且输出包含 ' + expectText),
        shell: { command: String(command).trim(), expectExit: 0, expectContains: expectText },
      }
      if (tier !== '') item.tier = tier
      await api('/task/case', { id: task.id, action: 'add', cases: [item] })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  // 浏览器用例：地址 + 期望文本 / 期望选择器。真跑要服务端打开 allowBrowser（会真开一个浏览器）。
  const addBrowserCase = async () => {
    const url = await promptDialog('页面地址（相对测试环境 baseUrl，或完整 http(s) 地址）', { title: '加一条浏览器用例', defaultValue: '/' })
    if (url === null || String(url).trim() === '') return
    const text = await promptDialog('页面上应该出现的文字（可留空）', { title: '加一条浏览器用例', defaultValue: '' })
    if (text === null) return
    const selector = await promptDialog('页面上应该存在的元素选择器（可留空）', { title: '加一条浏览器用例', defaultValue: '' })
    if (selector === null) return
    setBusy(true); setError(null)
    try {
      const expectText = String(text ?? '').trim()
      const expectSelector = String(selector ?? '').trim()
      const browser = { url: String(url).trim() }
      if (expectText !== '') browser.expectText = expectText
      if (expectSelector !== '') browser.expectSelector = expectSelector
      const expected = expectText !== '' ? ('页面含「' + expectText + '」') : (expectSelector !== '' ? ('存在元素 ' + expectSelector) : '页面能打开')
      await api('/task/case', { id: task.id, action: 'add', cases: [{ title: ('浏览器: ' + String(url).trim()).slice(0, 60), expected, tier: 'e2e', browser }] })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  /* 改定义：接口 / shell / 数据库 / 浏览器四种都能改。
     以前只有新建入口，写错地址或命令只能删了重建——lastRun 与历史一起丢。 */
  const saveCaseDefinition = async (item, patch) => {
    setBusy(true); setError(null)
    try {
      await api('/task/case', { id: task.id, action: 'update', caseId: item.id, ...patch })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const editCaseDefinition = item => {
    if (item.http != null) {
      setCaseEdit({ id: item.id, title: item.title, kind: 'http', method: item.http.method ?? 'GET', url: item.http.url ?? '', expectStatus: String(item.http.expectStatus ?? 200), expectContains: item.http.expectContains ?? '' })
      return
    }
    if (item.shell != null) {
      setCaseEdit({ id: item.id, title: item.title, kind: 'shell', command: item.shell.command ?? '', expectContains: item.shell.expectContains ?? '' })
      return
    }
    if (item.db != null) {
      setCaseEdit({ id: item.id, title: item.title, kind: 'db', file: item.db.file ?? '', sql: item.db.sql ?? '', expectColumn: item.db.expectColumn ?? '', expectValue: item.db.expectValue ?? '' })
      return
    }
    if (item.browser != null) {
      setCaseEdit({ id: item.id, title: item.title, kind: 'browser', url: item.browser.url ?? '/', expectText: item.browser.expectText ?? '', expectSelector: item.browser.expectSelector ?? '' })
    }
  }

  const saveCaseEdit = async () => {
    if (caseEdit === null) return
    const item = cases.find(entry => entry.id === caseEdit.id)
    if (item === undefined) { setCaseEdit(null); return }
    const text = value => String(value ?? '').trim()
    let patch = null
    if (caseEdit.kind === 'http') {
      if (text(caseEdit.url) === '') { setError('接口地址不能为空'); return }
      patch = { http: { ...item.http, method: text(caseEdit.method).toUpperCase() || 'GET', url: text(caseEdit.url), expectStatus: Number(caseEdit.expectStatus) || 200, expectContains: text(caseEdit.expectContains) } }
    } else if (caseEdit.kind === 'shell') {
      if (text(caseEdit.command) === '') { setError('shell 命令不能为空'); return }
      patch = { shell: { ...item.shell, command: text(caseEdit.command), expectContains: text(caseEdit.expectContains) } }
    } else if (caseEdit.kind === 'db') {
      if (text(caseEdit.file) === '' || text(caseEdit.sql) === '') { setError('库文件与 SQL 都不能为空'); return }
      patch = { db: { ...item.db, file: text(caseEdit.file), sql: text(caseEdit.sql), expectColumn: text(caseEdit.expectColumn), expectValue: text(caseEdit.expectValue) === '' ? null : text(caseEdit.expectValue) } }
    } else if (caseEdit.kind === 'browser') {
      if (text(caseEdit.url) === '') { setError('页面地址不能为空'); return }
      patch = { browser: { ...item.browser, url: text(caseEdit.url), expectText: text(caseEdit.expectText) === '' ? undefined : text(caseEdit.expectText), expectSelector: text(caseEdit.expectSelector) === '' ? undefined : text(caseEdit.expectSelector) } }
    }
    if (patch !== null) {
      await saveCaseDefinition(item, patch)
      setCaseEdit(null)
    }
  }

  const addCase = async () => {
    const title = newCase.title.trim()
    if (title === '') return
    setBusy(true); setError(null)
    try {
      const steps = parseSteps(newCase.steps)
      const item = { title, expected: newCase.expected.trim() }
      if (String(newCase.pointId ?? '').trim() !== '') item.pointId = String(newCase.pointId).trim()
      if (steps.length > 0) item.http = { steps }
      if (newCase.type !== undefined && newCase.type !== 'functional') item.type = newCase.type
      if (newCase.priority !== undefined && newCase.priority !== 'p2') item.priority = newCase.priority
      // 测试层级：空 = 按断言推断（接口/多步 → 集成，浏览器 → 端到端，单测命令 → 单元）
      if (String(newCase.tier ?? '') !== '') item.tier = String(newCase.tier)
      if (String(newCase.preconditions ?? '').trim() !== '') item.preconditions = String(newCase.preconditions).trim()
      if (String(newCase.stepsText ?? '').trim() !== '') {
        item.steps = String(newCase.stepsText).split('\n').map(line => line.trim()).filter(line => line !== '')
      }
      await api('/task/case', { id: task.id, action: 'add', cases: [item] })
      setNewCase({ title: '', expected: '', steps: '', stepsText: '', type: 'functional', tier: '', priority: 'p2', preconditions: '', pointId: newCase.pointId ?? task.pointId ?? '' })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const setCaseResult = async (item, result) => {
    setBusy(true); setError(null); setNotice(null)
    try {
      const json = await api('/task/case', { id: task.id, action: 'update', caseId: item.id, result })
      const bug = json?.bug ?? null
      if (result === 'fail' && bug !== null) {
        const label = String(bug.code ?? '') !== '' ? bug.code : bug.id
        setNotice(`用例判失败，已自动登记缺陷 ${label}（挂在同一条需求下，父任务指向本卡）。`)
      } else if (json?.error) {
        setNotice(`用例已更新，但自动建缺陷失败：${json.error}`)
      }
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const runCases = async caseId => {
    setCaseRun({ busy: true, note: '' })
    setError(null)
    try {
      // caseId: 单条；caseIds: 一整层（「跑这一层」）；都不传：全部能跑的
      const body = Array.isArray(caseId) ? { caseIds: caseId } : (caseId === undefined ? {} : { caseId })
      const out = await api('/task/case/run', { id: task.id, ...body, by: '我在界面里跑的' })
      const run = out?.run ?? {}
      const bugMap = {}
      for (const item of out?.bugs ?? []) { if (String(item.bug ?? '') !== '') bugMap[item.caseId] = item.bug }
      if (Object.keys(bugMap).length > 0) setCaseBugMap(previous => ({ ...previous, ...bugMap }))
      const made = (out?.bugs ?? []).filter(item => item.created === true).length
      const parts = [`跑了 ${run.total ?? 0} 条：通过 ${run.passed ?? 0}，不通过 ${run.failed ?? 0}`]
      if (made > 0) parts.push(`自动开缺陷 ${made} 张`)
      setCaseRun({ busy: false, note: parts.join('，') })
      await onChanged()
    } catch (cause) {
      setCaseRun({ busy: false, note: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  /* 三层测试：跑某一层 / 给某一层「不适用 + 理由」。界面直接改服务端同一份测试计划与用例分组，
     不在前端另算一遍进度（门禁读的是服务端那份）。 */
  const runTier = async tier => {
    const ids = cases
      .filter(item => (item.tierEffective ?? item.tier ?? '') === tier)
      .filter(item => item.http != null || item.shell != null || item.db != null || item.browser != null)
      .map(item => item.id)
    if (ids.length === 0) {
      setCaseRun({ busy: false, note: `${CASE_TIER_FULL[tier] ?? tier}这一层还没有能跑的用例：先加一条，或在大模型会话里用 studio_task_add_cases 补。` })
      return
    }
    await runCases(ids)
  }
  const setTierApplicable = async (tier, applicable) => {
    let reason
    if (applicable !== true) {
      reason = await promptDialog(`为什么「${CASE_TIER_FULL[tier] ?? tier}」这一层不适用？`, {
        title: '测试计划',
        defaultValue: '',
        placeholder: '例如：本次只改后端接口，没有前端改动；或用例需要真实设备，环境拿不到',
      })
      if (reason === null || String(reason).trim() === '') return
    }
    setBusy(true); setError(null)
    try {
      await api('/task/test-plan', {
        id: task.id,
        tiers: applicable === true ? [{ tier, applicable: true }] : [{ tier, applicable: false, reason: String(reason).trim() }],
        by: '我在界面里设的',
      })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const setCaseTier = async (item, tier) => {
    setBusy(true); setError(null)
    try {
      // 空串 = 恢复「按断言推断」，不是 other
      await api('/task/case', { id: task.id, action: 'update', caseId: item.id, tier: String(tier ?? '') })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const generateCases = async () => {
    setCaseGen({ busy: true, note: '' })
    setError(null)
    try {
      const out = await api('/task/cases/generate', { id: task.id })
      const note = out?.added > 0
        ? `已生成 ${out.added} 条草稿（只有标题，不计入覆盖率）；补上 method+path 或 command 才能跑，优先用 studio_task_add_cases。`
        : `没生成用例：${out?.reason ?? '没有可用的验收条件'}`
      setCaseGen({ busy: false, note })
      await onChanged()
    } catch (cause) {
      setCaseGen({ busy: false, note: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  const removeCase = async (item) => {
    if (!(await confirmDialog(`删除用例「${item.title}」？删掉后不可恢复。`, { title: '删除用例', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null)
    try { await api('/task/case', { id: task.id, action: 'remove', caseId: item.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const toggleFlaky = async (item) => {
    setBusy(true); setError(null); setNotice(null)
    try {
      await api('/task/case', { id: task.id, action: 'update', caseId: item.id, flaky: item.flaky !== true })
      setNotice(item.flaky === true ? '已取消不稳定标记' : '已标记为不稳定用例：以后失败不会自动开缺陷')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const addArtifact = async () => {
    const title = artifact.title.trim()
    if (title === '') return
    setBusy(true); setError(null); setNotice(null)
    try {
      const json = await api('/task/artifact', { id: task.id, action: 'add', artifact: { kind: artifact.kind, title, ref: artifact.ref.trim(), content: artifact.content, status: 'delivered' } })
      setArtifact({ kind: artifact.kind, title: '', ref: '', content: '' })
      setNotice(archivePendingNotice())
      await onChanged()
      try {
        const synced = await api('/task/artifact/sync', { id: task.id })
        const first = (synced?.written ?? [])[0]
        setNotice(first?.doc?.url ? archiveNotice(first.doc) : '归档失败，稍后可点「同步到云盘」重试。')
        await onChanged()
      } catch { setNotice('登记成功，但归档失败：可点「同步到云盘」重试。') }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const saveArtifactContent = async (item) => {
    if (artEdit === null) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const savedContent = artEdit.content
      await api('/task/artifact', { id: task.id, action: 'update', artifactId: item.id, artifact: { content: savedContent } })
      setArtEdit(null)
      setArtBodies(previous => ({ ...previous, [item.id]: savedContent }))
      await onChanged()
      try {
        const synced = await api('/task/artifact/sync', { id: task.id, artifactId: item.id })
        const doc = (synced?.written ?? [])[0]?.doc
        setNotice(doc?.url ? archiveNotice(doc, { verb: '正文已更新并同步' }) : '正文已保存，归档失败可再点「更新」。')
        await onChanged()
      } catch { setNotice('正文已保存，归档失败可再点「更新」。') }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const syncArtifactTo = async (item) => {
    setBusy(true); setError(null); setNotice(null)
    try {
      const json = await api('/task/artifact/sync', { id: task.id, artifactId: item.id })
      const doc = (json?.written ?? [])[0]?.doc
      const failed = (json?.errors ?? [])[0]
      setNotice(doc?.url ? archiveNotice(doc) : archiveFailureNotice(doc?.provider, failed?.error))
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const syncAllArtifacts = async () => {
    setBusy(true); setError(null); setNotice(null)
    try {
      const json = await api('/task/artifact/sync', { id: task.id })
      const ok = (json?.written ?? []).length
      const bad = (json?.errors ?? []).length
      setNotice(`已归档 ${ok} 件${bad > 0 ? `，${bad} 件失败：${json.errors[0]?.error ?? ''}` : '。'}`)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const setArtifactStatus = async (item, status) => {
    setBusy(true); setError(null)
    try { await api('/task/artifact', { id: task.id, action: 'update', artifactId: item.id, artifact: { status } }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const removeArtifact = async (item) => {
    /* 交付物正文随记录一起消失，云盘那份文档会变成孤儿（卡上再无入口），必须二次确认。 */
    if (!(await confirmDialog(`删除交付物「${String(item.title ?? '').slice(0, 40)}」？正文与云盘入口都会消失，云盘上已归档的文档不会被删。`, { title: '删除交付物', danger: true, okText: '删除' }))) return
    setBusy(true); setError(null)
    try { await api('/task/artifact', { id: task.id, action: 'remove', artifactId: item.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const openCoding = () => setCodingDraft({
    agent: coding?.agent ?? '',
    model: coding?.model ?? '',
    branch: coding?.branch ?? '',
    context: coding?.context ?? '',
    total: String(coding?.unitTests?.total ?? 0),
    passed: String(coding?.unitTests?.passed ?? 0),
  })
  const worktreeAction = async (action) => {
    if (action === 'remove' && !(await confirmDialog('回收 worktree 会删掉这个目录和分支，未合并的改动会丢，确定？', { title: '回收 worktree', danger: true, okText: '回收' }))) return
    setBusy(true); setError(null); setWorktreeMsg('')
    try {
      const result = await api('/task/worktree', { id: task.id, action })
      if (action === 'list') setWorktreeMsg(String(result.output ?? '').replace(/\s+/g, ' ').slice(0, 400) || '（没有 worktree）')
      else if (result.ok === true) setWorktreeMsg(action === 'create' ? '已建好 worktree' : '已回收')
      else setWorktreeMsg(result.skipped || result.result?.error || '没成功')
      if (action !== 'list') await onChanged()
    } catch (cause) { setWorktreeMsg(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const saveCoding = async () => {
    if (codingDraft === null) return
    const total = Math.max(0, Number(codingDraft.total) || 0)
    const passed = Math.min(total, Math.max(0, Number(codingDraft.passed) || 0))
    setBusy(true); setError(null)
    try {
      await api('/task/coding', {
        id: task.id, action: 'update',
        coding: {
          agent: codingDraft.agent.trim(), model: codingDraft.model.trim(), branch: codingDraft.branch.trim(),
          context: codingDraft.context, unitTests: { total, passed },
        },
      })
      setCodingDraft(null)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const reviewCoding = async (status) => {
    setBusy(true); setError(null)
    try { await api('/task/coding', { id: task.id, action: 'review', status, note: reviewNote.trim(), by: currentUser() }); setReviewNote(''); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  /* 手动「标记已合并」已移除：它只写 mergedAt（自报），真合并走「合并门禁 → 合并 MR」。 */
  // 核对代码事实：拿 worktree 里的 git 记录，比 agent 自报的提交/文件/分支。
  const verifyCoding = async () => {
    setVerify({ busy: true, line: '', ok: null })
    try {
      const result = await api('/task/coding/verify', { id: task.id })
      const report = result.report ?? {}
      if (report.skipped !== undefined) setVerify({ busy: false, line: String(report.skipped), ok: false })
      else setVerify({ busy: false, line: String(result.line ?? ''), ok: report.ok === true })
      await onChanged()
    } catch (cause) {
      setVerify({ busy: false, line: cause instanceof Error ? cause.message : String(cause), ok: false })
    }
  }
  // 项目检查：在项目目录（有 worktree 就用它）里跑一次本地质量命令，结果写回卡片并参与准出。
  // 服务端改成「提交即返回 202」：编译类命令能跑 1～2 分钟，同步等会被反代 60s 断连，
  // 结果本来就会写回卡上，这里只要说清「已提交」，结果靠已有的轮询回来。
  const runQuality = async () => {
    setQualityRun({ busy: true, line: '' })
    try {
      const result = await api('/task/quality', { id: task.id, by: currentUser() })
      if (result.queued === true) {
        setQualityRun({ busy: false, line: '已提交后台执行：跑完会写回这张卡（不用等在这里）' })
        return
      }
      const last = result.quality ?? {}
      const exit = last.exitCode === null || last.exitCode === undefined ? '' : ` · 退出码 ${last.exitCode}`
      setQualityRun({
        busy: false,
        line: `${last.ok === true ? '通过' : '不通过'}${last.timedOut === true ? '（超时）' : ''}${exit} · ${Math.round((Number(last.ms) || 0) / 100) / 10}s`,
      })
      await onChanged()
    } catch (cause) {
      setQualityRun({ busy: false, line: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  // 技能沉淀：把这张卡上的证据汇总成技能草稿（服务端只搬事实，不推断）。
  const mineSkill = async () => {
    setMine({ busy: true, line: '' })
    try {
      const result = await api('/skill/mine', { taskId: task.id })
      const e = result.evidence ?? {}
      setMine({
        busy: false,
        line: `已存为草稿「${result.skill?.name ?? '?'}」：验收锚点 ${e.anchors ?? 0} 条 · 能跑的用例 ${e.verifications ?? 0} 条 · 踩坑 ${e.pitfalls ?? 0} 条。到 设置 → 技能库 启用后才会被派单注入。`,
      })
      await onChanged()
    } catch (cause) {
      setMine({ busy: false, line: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  // 合并门禁：算一次「能不能合」，并把这个结论发布成 GitLab 提交状态。
  const syncMergeGate = async () => {
    setMergeRun({ busy: true, line: '' })
    try {
      const result = await api('/task/merge-gate', { id: task.id, by: currentUser() })
      const status = result.mergeGate ?? {}
      setMergeRun({
        busy: false,
        line: `${status.state === 'success' ? '已发布：通过' : '已发布：不通过'}${status.sha ? `（sha ${String(status.sha).slice(0, 8)}）` : ''}`,
      })
      await onChanged()
    } catch (cause) {
      setMergeRun({ busy: false, line: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  // 设计多稿的读写（定案与评审的变量在文件上方、tabs 之前定义）
  const saveDesignPatch = async patch => {
    setBusy(true); setError(null); setNotice(null)
    try {
      const out = await api('/task/design', { id: task.id, design: { ...(task.design ?? {}), ...patch } })
      setNotice(out?.design?.status === 'approved'
        ? `设计评审通过${out.design.chosenId === '' ? '（还没定案：进开发前要选一稿）' : ''}`
        : `设计已保存：${DESIGN_LABEL[out?.design?.status] ?? out?.design?.status ?? ''}`)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const addDesignDraft = async () => {
    const name = await promptDialog('这一稿的名字（如「方案 A：卡片流」）', { title: '加一稿', defaultValue: `方案 ${String.fromCharCode(65 + designDrafts.length)}` })
    if (name === null) return
    const link = await promptDialog('稿子链接（Figma / 蓝湖 / 图片 / HTML 预览都行）', { title: '加一稿', defaultValue: '' })
    if (link === null || String(link).trim() === '') return
    const note = await promptDialog('一句话说明这一稿的思路（可留空）', { title: '加一稿', defaultValue: '' })
    if (note === null) return
    const draft = { id: 'd' + Date.now().toString(36), name: String(name).trim(), link: String(link).trim(), note: String(note).trim() }
    await saveDesignPatch({ drafts: [...designDrafts, draft], status: task.design?.status ?? 'pending' })
  }
  /* 标重复 / 取消重复：主缺陷传编号或 id 都行（服务端认 code 与 id）。
     空 target 表示取消标记。 */
  const markDuplicate = async target => {
    let targetId = target
    if (targetId === undefined) {
      const input = await promptDialog('主缺陷的编号或 id（例如 BUG-001）', { title: '标为重复', okText: '标为重复' })
      if (input === null || String(input).trim() === '') return
      const wanted = String(input).trim()
      const hit = (state.tasks ?? []).find(item => item.id === wanted || item.code === wanted)
      if (hit === undefined) { setError(`找不到这张卡：${wanted}`); return }
      if (hit.id === task.id) { setError('不能把自己标成重复'); return }
      targetId = hit.id
    }
    setBusy(true); setError(null); setNotice(null)
    try {
      await api('/task/duplicate', { id: task.id, targetId })
      setNotice(targetId === '' ? '已取消重复标记' : '已标为重复，并留了评论')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const designAction = async (action, draftId) => {    if (action === 'choose') return saveDesignPatch({ chosenId: draftId })
    if (action === 'remove') {
      const rest = designDrafts.filter(item => item.id !== draftId)
      return saveDesignPatch({ drafts: rest, chosenId: task.design?.chosenId === draftId ? '' : (task.design?.chosenId ?? '') })
    }
    if (action === 'approve') return saveDesignPatch({ status: 'approved', note: String(designNote ?? '').trim() })
    if (action === 'changes') {
      /* 驳回必须给意见：研发照着「评审意见」改，空的等于让人猜。
         备注里的 @ 也会被服务端补成评论并派单（publishNoteMentions）。 */
      const written = await promptDialog('哪里不满足？要改什么（会记成评审意见，备注里的 @某人 会叫起他）', {
        title: '设计评审意见',
        danger: true,
        okText: '要求修改',
        defaultValue: String(designNote ?? task.design?.note ?? ''),
        placeholder: '例如：卡片密度太高，按「方案 A」改成两列；@开发工程师 改完再叫我',
      })
      if (written === null) return
      if (String(written).trim() === '') { setError('要求修改要写一句意见：研发按它改'); return }
      setDesignNote(String(written).trim())
      return saveDesignPatch({ status: 'changes_requested', note: String(written).trim() })
    }
  }
  // 还原度与规范体检：数字来自 tools/visual 的 design-diff / design-audit（要在装了 Chrome 的机器上跑），
  // 这里让人把结果录进来，卡片上才看得到还原度和规范野值。
  const editDesignMetrics = async () => {
    const diffText = await promptDialog('还原度差异百分比（design-diff 输出，留空跳过）', { title: '设计还原度', defaultValue: task.design?.diff == null ? '' : String(task.design.diff.percent) })
    if (diffText === null) return
    const violationsText = await promptDialog('规范体检野值数（design-audit 输出，留空跳过）', { title: '设计规范体检', defaultValue: task.design?.spec == null ? '' : String(task.design.spec.violations) })
    if (violationsText === null) return
    const patch = {}
    const diffNumber = Number(String(diffText).trim())
    if (String(diffText).trim() !== '' && Number.isFinite(diffNumber)) patch.diff = { percent: diffNumber, url: String(task.design?.diff?.url ?? '') }
    const violations = Number(String(violationsText).trim())
    if (String(violationsText).trim() !== '' && Number.isFinite(violations)) patch.spec = { checked: task.design?.spec?.checked ?? 0, violations, top: task.design?.spec?.top ?? [] }
    if (Object.keys(patch).length === 0) return
    await saveDesignPatch(patch)
  }
  // 真的去 GitLab 合并：GitLab CE 没有外部状态检查，合并按钮拦不住人，
  // 所以「让门禁生效」的方式是——合并由平台执行，门禁没过就不发这个请求。
  const mergeNow = async () => {
    if (!(await confirmDialog('真的去 GitLab 合并这个 MR？合并后会删除源分支，且无法撤销。', { title: '合并 MR', danger: true, okText: '合并' }))) return
    setMergeRun({ busy: true, line: '' })
    try {
      const result = await api('/task/merge', { id: task.id, by: currentUser() })
      const merge = result.merge ?? {}
      setMergeRun({ busy: false, line: `已合并 MR !${merge.iid}${merge.sha ? `（merge commit ${String(merge.sha).slice(0, 8)}）` : ''}` })
      await onChanged()
    } catch (cause) {
      setMergeRun({ busy: false, line: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  // 从 GitLab 核对：拉 MR 的 changes 与流水线，和卡上自报的值比一遍（没配 GitLab 会直接提示）。
  const verifyGitlab = async () => {
    setBusy(true); setError(null); setNotice(null)
    try {
      const out = await api('/coding/gitlab', { id: task.id })
      const facts = out?.facts ?? null
      setNotice(facts === null
        ? '核对完成，但没有拿到结果'
        : `GitLab 核对：文件 ${facts.files.declared}→${facts.files.actual} · 提交 ${facts.commits.declared}→${facts.commits.actual}${(facts.commitList ?? []).length > 0 ? `（拿到 ${facts.commitList.length} 条明细）` : ''}${facts.pipeline ? ` · 流水线 ${facts.pipeline}` : ''}${facts.ci ? ` · CI ${facts.ci.passed}/${facts.ci.total}` : ''}${(facts.mismatches ?? []).length > 0 ? ` · 不一致：${facts.mismatches.join('；')}` : ' · 一致'}`)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  /* 三层测试进度块：单元 / 集成 / 端到端各一行（通过/总数、可执行数、缺口或理由），
     每行可以「跑这一层」或标记「不适用 + 理由」。数字来自服务端 parts.plan，界面不重算口径。 */
  /* 改定义：接口 / shell / 数据库 / 浏览器各一组字段，一次保存。 */
  const caseEditBlock = () => {
    if (caseEdit === null) return null
    const line = (label, node) => h('label', { className: 'flex min-w-0 flex-col gap-1' },
      h('span', { className: 'text-caption-2-medium text-text-secondary' }, label),
      node,
    )
    const textField = (key, label, placeholder) => line(label, h(TextField, {
      value: caseEdit[key] ?? '', placeholder,
      onChange: event => setCaseEdit({ ...caseEdit, [key]: event.target.value }),
    }))
    let fields = null
    if (caseEdit.kind === 'http') {
      fields = h(React.Fragment, null,
        line('HTTP 方法', h(SelectField, {
          value: caseEdit.method, size: 'sm',
          'aria-label': 'HTTP 方法',
          onChange: event => setCaseEdit({ ...caseEdit, method: event.target.value }),
        }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(method => h('option', { key: method, value: method }, method)))),
        textField('url', '地址（相对测试环境 baseUrl，或完整 http(s)）', '/api/points/available'),
        textField('expectStatus', '期望状态码', '200'),
        textField('expectContains', '响应里应包含什么（可留空）', '\"availablePoints\"'),
      )
    } else if (caseEdit.kind === 'shell') {
      fields = h(React.Fragment, null,
        line('shell 命令', h(TextAreaField, {
          rows: 3, value: caseEdit.command ?? '',
          onChange: event => setCaseEdit({ ...caseEdit, command: event.target.value }),
        })),
        textField('expectContains', '期望输出里包含什么（可留空）', 'ok'),
      )
    } else if (caseEdit.kind === 'db') {
      fields = h(React.Fragment, null,
        textField('file', 'SQLite 库文件路径', 'server/data.sqlite'),
        line('SQL 语句', h(TextAreaField, {
          rows: 3, value: caseEdit.sql ?? '',
          onChange: event => setCaseEdit({ ...caseEdit, sql: event.target.value }),
        })),
        textField('expectColumn', '断言首行的哪一列（可留空）', 'count'),
        textField('expectValue', '这一列的期望值（可留空）', '1'),
      )
    } else {
      fields = h(React.Fragment, null,
        textField('url', '页面地址（相对 baseUrl 或完整 http(s)）', '/'),
        textField('expectText', '页面上应该出现的文字（可留空）', '订单管理'),
        textField('expectSelector', '应该存在的元素选择器（可留空）', '#root'),
      )
    }
    return h('div', { className: 'flex min-w-0 flex-col gap-3 rounded-xl border border-separator-border bg-background-secondary-default p-3', 'data-case-edit': '' },
      h('div', { className: 'flex items-center justify-between gap-2' },
        h('div', { className: 'text-body-2-semibold text-text-primary' }, '编辑用例：' + caseEdit.title),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => setCaseEdit(null) }, '取消'),
      ),
      fields,
      h('div', { className: 'flex justify-end' },
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveCaseEdit() }, busy ? '保存中…' : '保存定义'),
      ),
    )
  }

  const testPlanBlock = () => {
    if (testPlanTiers.length === 0) return null
    /* 产品/设计卡不受三层闸门约束：没有用例也没有测试计划时不显示这个块，
       否则每张需求卡一打开「测试」页都是「缺 单元/集成/端到端」，像在报假警。 */
    const codeLike = ['dev', 'test', 'bug'].includes(String(task.type ?? ''))
    if (!codeLike && cases.length === 0 && testRuns.length === 0) return null
    const required = testPlanTiers.filter(row => CASE_TIERS.includes(row.tier) && row.tier !== 'other')
    if (required.length === 0) return null
    const gapSet = new Set(testPlanGaps.map(gap => gap.tier))
    return h('details', { className: PANEL, 'data-test-plan': '' },
      h('summary', { className: 'flex cursor-pointer list-none flex-wrap items-center gap-2 border-b border-separator-border px-4 py-3 [&::-webkit-details-marker]:hidden', 'data-test-plan-summary': '' },
        h('span', { className: 'text-body-2-semibold text-text-primary' }, '三层测试'),
        required.map(row => h(ChipField, {
          key: row.tier,
          variant: row.applicable === false ? 'neutral' : (row.fail > 0 ? 'rose' : (row.executable === 0 ? 'yellow' : 'lime')),
          title: `${CASE_TIER_FULL[row.tier]}：通过 ${row.pass}/${row.total}，可执行 ${row.executable}`,
        }, `${CASE_TIER_LABEL[row.tier]} ${row.pass}/${row.total}`)),
        testPlanGaps.length === 0
          ? h(ChipField, { variant: 'lime', 'data-test-gap': '0' }, '三条线齐全')
          : h(ChipField, { variant: 'yellow', 'data-test-gap': testPlanGaps.map(gap => gap.tier).join(',') }, `缺 ${testPlanGaps.map(gap => CASE_TIER_LABEL[gap.tier] ?? gap.tier).join('/')}`),
        h('span', { className: 'ml-auto text-caption-1-regular text-text-tertiary' }, '展开明细'),
      ),
      h('div', { className: 'flex min-w-0 flex-col gap-2 p-4' },
      required.map(row => h('div', {
        key: row.tier,
        className: LIST_LINE,
        'data-tier-row': row.tier,
        'data-tier-state': row.applicable === false ? 'excluded' : (row.executable === 0 ? 'missing' : (row.fail > 0 ? 'fail' : 'ok')),
      },
        h('div', { className: 'w-[88px] shrink-0 text-body-2-semibold text-text-primary' }, CASE_TIER_FULL[row.tier]),
        h('div', { className: GROW },
          h('div', { className: ROW, style: { gap: 8 } },
            h('span', { className: 'tabular-nums text-caption-1-regular text-text-secondary' }, `通过 ${row.pass}/${row.total}`),
            h('span', { className: HINT }, `可执行 ${row.executable}`),
            row.fail > 0 ? h(ChipField, { variant: 'rose' }, `不通过 ${row.fail}`) : null,
            row.total - row.executable > 0 ? h(ChipField, { variant: 'yellow' }, `${row.total - row.executable} 条跑不了`) : null,
            row.applicable === false
              ? h(ChipField, { variant: 'neutral', title: row.reason }, '不适用')
              : (gapSet.has(row.tier) ? h(ChipField, { variant: 'yellow' }, '缺') : h(ChipField, { variant: 'lime' }, '已覆盖')),
          ),
          row.applicable === false && row.reason !== '' ? h('div', { className: ART_REF }, `理由：${row.reason}`) : null,
          row.total === 0
            ? h('div', { className: 'mt-1 text-caption-1-regular text-text-tertiary' }, '这一层还没有用例')
            : h('div', { className: 'mt-1' },
              h(ProgressTrack, { percentage: Math.round(row.pass / row.total * 100), size: 'sm' }),
            ),
        ),
        row.applicable === false
          ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: '恢复为适用：这一层要补用例并跑通', onClick: () => void setTierApplicable(row.tier, true) }, '恢复适用')
          : h(Button, {
            variant: 'ghost', size: 'sm',
            disabled: busy || caseRun.busy || (row.executable ?? 0) === 0,
            title: (row.executable ?? 0) === 0 ? '这一层还没有可执行用例：先补用例，或标「本层不适用」写明理由' : '只跑这一层里能跑的用例',
            'data-tier-action': 'run',
            onClick: () => void runTier(row.tier),
          }, [uiIcon(h, 'run'), ' 跑这层']),
        row.applicable === false
          ? null
          : h('button', {
            type: 'button',
            className: 'shrink-0 rounded px-1 text-caption-1-regular text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring disabled:cursor-default disabled:opacity-50',
            disabled: busy,
            title: '这一层确实验不了：写明理由，门禁认它',
            'data-tier-action': 'exclude',
            onClick: () => void setTierApplicable(row.tier, false),
          }, '本层不适用'),
      )),
      testRuns.length === 0 ? null : (() => {
        const latest = testRuns[testRuns.length - 1]
        return h('div', { className: ROW, style: { gap: 10, marginTop: 2 }, 'data-test-runs': '' },
          h('span', { className: HINT }, '最近执行'),
          h('span', { className: HINT, title: latest.by ? `执行人：${latest.by}` : '' },
            `${fmtTime(latest.at)} · ${latest.passed ?? 0}/${latest.total ?? 0} 通过${(latest.failed ?? 0) > 0 ? ` · ${latest.failed} 失败` : ''}`),
          testRuns.length > 1 ? h('span', { className: HINT }, `共 ${testRuns.length} 次`) : null,
        )
      })(),
      ),
    )
  }

  /* 协作链：四个角色各自要交的东西，一行一个；状态只从已有事实推导（需求功能点/验收条件、设计定案、
     执行记录与评审、三层测试进度），不另做一套统计。 */
  const roleRow = (key, label, tone, chip, detail) => h('div', {
    key,
    className: LIST_LINE,
    'data-role-row': key,
    'data-role-state': tone,
  },
    h('div', { className: 'w-[72px] shrink-0 text-body-2-semibold text-text-primary' }, label),
    h('div', { className: GROW },
      h('div', { className: ROW, style: { gap: 8 } },
        h(ChipField, { variant: tone === 'ok' ? 'lime' : tone === 'bad' ? 'rose' : tone === 'warn' ? 'yellow' : 'neutral' }, chip),
        detail === '' ? null : h('span', { className: HINT }, detail),
      ),
    ),
  )
  /* 子卡没到「已完成」时主卡签不了（服务端会拒）——按钮上先说清楚，别等人点了才发现没反应。 */
  const pendingChildren = (state.tasks ?? []).filter(item => String(item.parent ?? '') === String(task.id ?? '') && item.status !== 'done')
  /* 子卡按钮上要显示它现在的列名；这个 helper 在合并时被丢掉过一次（只剩调用），
     结果一开抽屉就 ReferenceError → 整页「工作空间渲染失败」。 */
  const statusLabelOf = id => (state.statuses ?? []).find(item => item.id === id)?.label ?? String(id ?? '')
  /* 执行播报（机器进度）：/state 只下发最近几条（文本已截断），完整历史在台账里。 */
  const feedList = Array.isArray(task.feed) ? task.feed : []
  const feedCount = Number(task.feedCount ?? feedList.length)
  const collabRequirement = (state.requirements ?? []).find(item => item.id === task.requirementId) ?? null
  const collabDesign = task.design ?? null
  const collabDrafts = Array.isArray(collabDesign?.drafts) ? collabDesign.drafts : []
  const collabChosen = collabDrafts.find(item => item.id === collabDesign?.chosenId) ?? null
  const collabCoding = task.coding ?? null
  const collabQuality = task.quality ?? null
  const collabPlanRows = testPlanTiers.filter(row => CASE_TIERS.includes(row.tier) && row.tier !== 'other')
  const collabGaps = testPlanGaps.map(gap => CASE_TIER_LABEL[gap.tier] ?? gap.tier)

  /* 执行记录页的六个区块：抽成具名函数后，顺序在调用处一眼可见（以前是 470 行内联 JSX）。 */
  const renderCodingSection = () => (
      h(Section, { pane: 'coding', current: pane, id: 'coding' },
        h(SectionHead, null, 'AI Coding 执行记录',
          h('span', { className: HINT }, coding === null ? '改代码要留记录：谁、什么模型、改了什么' : '研发 agent 登记，人也可以补录或评审')),
        h('div', { className: SECTION_BODY },
          coding === null
            ? h(EmptyState, { title: '还没有执行记录。', hint: '让研发 agent 登记，或点下面的「手动补录执行记录」自己填：agent / 模型 / 分支 / 单测数' })
            : h('div', { className: PANEL },
              h('div', { className: PANEL_HEAD },
                /* 语义上色：通过=绿、要求修改=红、待评审=黄。以前恒为 gray，只能靠读字分辨。 */
                h(ChipField, { variant: REVIEW_CHIP_VARIANT[coding.review.status] ?? 'gray', 'data-review': coding.review.status }, CODING_REVIEW_LABEL[coding.review.status] ?? coding.review.status),
               h('div', { className: GROW },
                  h('div', { className: PANEL_LINE }, [coding.agent || '未登记 agent', coding.model, coding.branch].filter(Boolean).join(' · ')),
                  coding.context === '' ? null : h('details', { 'data-coding-context': '' },
                    h('summary', { className: HINT + ' cursor-pointer', title: coding.context }, coding.context.length > 80 ? coding.context.slice(0, 80) + '…' : coding.context),
                    h('div', { className: HINT + ' mt-1 whitespace-pre-wrap break-words' }, coding.context)),
                ),
                (() => {
                  const unit = coding.unitTests ?? {}
                  const total = Number(unit.total) || 0
                  const passed = Number(unit.passed) || 0
                  const failed = Math.max(0, total - passed)
                  if (total === 0) return h(ChipField, { variant: 'gray', title: '这次执行没有自报单测' }, '无单测')
                  return h(ChipField, {
                    variant: failed > 0 ? 'rose' : 'lime',
                    title: '这次执行自报的单测结果（不是平台跑的）',
                  }, `单测 ${passed}/${total}${failed > 0 ? ` · 失败 ${failed}` : ''}`)
                })(),
                worktree === null
                  ? tipOf('这张卡还没有 worktree：先去「执行记录 → 工作树」建一个，或让研发登记分支',
                    h(Button, { variant: 'ghost', size: 'sm', disabled: true }, '核对代码事实'))
                  : tipOf(
                  '拿 worktree 里的 git 记录，比执行记录里自报的提交 / 文件 / 分支',
                  h(Button, {
                    variant: 'ghost', size: 'sm', disabled: busy || verify.busy,
                    onClick: () => void verifyCoding(),
                  }, verify.busy ? '核对中…' : (verify.line === '' ? '核对代码事实' : '再核对一次')),
                ),
                /* 没关联 MR 时直接 disabled：以前点下去才报错，等于让人白点一次。 */
                h(Button, {
                  variant: 'ghost', size: 'sm',
                  disabled: busy || !(Number(task.gitlabMR?.iid) > 0),
                  title: Number(task.gitlabMR?.iid) > 0
                    ? '拉 MR 的改动、逐条提交、流水线与 CI 单测结果，和自报的文件数/提交数/单测数比一遍'
                    : '这张卡还没关联 MR（在「计划」或执行记录里填 MR 号），没东西可核对',
                  onClick: () => void verifyGitlab(),
                }, '从 GitLab 核对'),
              /* 结论行（独占一行，不参与头部宽度竞争）。四态：未同步 / 不适用 / 还差 N 项 / 已通过。
                 以前 mergeGate===null 时 blockers 兜成空数组 → 直接写「已通过」，而这卡的门禁从未算过。 */
              (() => {
                const gate = task.mergeGate
                const who = coding.review.by === '' ? '未记评审人' : coding.review.by
                const when = coding.review.at > 0 ? fmtTime(coding.review.at) : '—'
                const blockers = Array.isArray(gate?.blockers) ? gate.blockers : []
                let gateText = '合并门禁：未同步（去下面「合并门禁」同步一次）'
                if (gate !== null && gate !== undefined) {
                  if (gate.applicable === false) gateText = '合并门禁：不适用（这张卡没有代码改动）'
                  else if (blockers.length > 0) gateText = `合并门禁：还差 ${blockers.length} 项：${blockers.slice(0, 2).join('；')}${blockers.length > 2 ? ' 等' : ''}`
                  else if (gate.state === 'success') gateText = '合并门禁：已通过'
                  else if (gate.state === 'failed') gateText = '合并门禁：未通过（见下方门禁块）'
                  else gateText = '合并门禁：待检查'
                }
                return h('div', { className: HINT, 'data-review-conclusion': coding.review.status, 'data-gate-state': gate === null || gate === undefined ? 'unsynced' : (gate.applicable === false ? 'n/a' : gate.state) },
                  `${who} · ${when} · ${gateText}`)
              })(),
              /* 主行动贴到结论旁边（UX：结论在最上、行动在最下，中间隔着 291px）：
                 评审通过 / 要求修改 常显；意见输入默认收起，点「写意见」再展开。 */
              (() => {
                const done = coding.review.status
                return h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2', 'data-review-actions': '' },
                  h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void reviewCoding('approved') }, busy ? '提交中…' : '评审通过'),
                  h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => void reviewCoding('changes_requested') }, '要求修改'),
                  h(Button, { variant: 'ghost', size: 'sm', 'data-review-note-toggle': '', onClick: () => setNoteOpen(!noteOpen) }, noteOpen ? '收起意见' : '写意见'),
                  noteOpen ? null : h('span', { className: HINT }, `${done === 'approved' ? '已通过' : done === 'changes_requested' ? '已要求修改' : '待评审'}；意见可写可不写`),
                )
              })(),
              noteOpen ? h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2' },
                h(TextField, { size: 'small', style: { flex: 1 }, value: reviewNote, placeholder: '评审意见（可选，写清文件/行为什么/怎么改）', onChange: event => setReviewNote(event.target.value) }),
              ) : null,
              ),
              verify.line === ''
                ? (coding.verified === null || coding.verified === undefined
                  ? null
                  : h('div', { className: HINT, 'data-verify': coding.verified.ok ? 'ok' : 'bad', style: { marginTop: 8 } },
                    `${coding.verified.ok ? '' : '注意 · '}上次核对 ${fmtTime(coding.verified.at)}：分支 ${coding.verified.branch} · 提交 ${coding.verified.commitCount.actual} 个 · 改动 ${coding.verified.fileCount.actual} 个文件` +
                    `${coding.verified.missingCommits.length + coding.verified.missingFiles.length === 0 ? '' : ` · ${coding.verified.missingCommits.length + coding.verified.missingFiles.length} 项对不上`}`))
                : h('div', { className: HINT, 'data-verify': verify.ok === true ? 'ok' : 'bad', style: { marginTop: 8 } },
                  `${verify.ok === true ? '' : '注意 · '}${verify.line}`),
                              coding.gitlab === null || coding.gitlab === undefined
                ? null
                : h('div', null,
                  h('div', { className: HINT, 'data-gitlab-facts': coding.gitlab.state },
                    '上次 GitLab 核对 ' + fmtTime(coding.gitlab.at) + '：文件 ' + coding.gitlab.files.declared + '→' + coding.gitlab.files.actual +
                    ' · 提交 ' + coding.gitlab.commits.declared + '→' + coding.gitlab.commits.actual +
                    (coding.gitlab.pipeline === null ? '' : ' · 流水线 ' + coding.gitlab.pipeline) +
                    (coding.gitlab.ci === null || coding.gitlab.ci === undefined
                      ? ''
                      : coding.gitlab.ci.source === 'test_report'
                        ? ' · CI 单测 ' + coding.gitlab.ci.passed + '/' + coding.gitlab.ci.total + (coding.gitlab.ci.failed > 0 ? `（失败 ${coding.gitlab.ci.failed}）` : '')
                        : ' · CI 任务 ' + coding.gitlab.ci.passed + '/' + coding.gitlab.ci.total + ' 成功' + (coding.gitlab.ci.failed > 0 ? `（失败 ${coding.gitlab.ci.failed}）` : '')) +
                    ((coding.gitlab.mismatches ?? []).length === 0 ? ' · 一致' : ' · ' + coding.gitlab.mismatches.join('；'))),
                  (coding.gitlab.commitList ?? []).length === 0 ? null : h('details', { 'data-gitlab-commits': '' },
                    h('summary', { className: 'cursor-pointer text-caption-1-regular text-text-secondary' }, `MR 里 ${coding.gitlab.commitList.length} 次提交`),
                    h('div', { className: 'mt-1 flex max-h-56 min-w-0 flex-col gap-1 overflow-auto pr-1' },
                      coding.gitlab.commitList.slice(0, 20).map(item => h('div', { key: 'gl-' + item.id, className: LIST_LINE },
                        h('code', { className: CODE_CHIP }, String(item.sha ?? '').slice(0, 8)),
                        h('span', { className: GROW }, item.title || '(无提交说明)'),
                        h('span', { className: HINT }, item.author || 'GitLab'),
                      )),
                      coding.gitlab.commitList.length > 20 ? h('div', { className: HINT }, `MR 里还有 ${coding.gitlab.commitList.length - 20} 次提交`) : null,
                    )),
                  (coding.gitlab.missingCommits ?? []).length === 0 ? null : h('div', { className: HINT, 'data-warn': '1' },
                    '这些自报提交在 MR 里找不到：' + coding.gitlab.missingCommits.map(sha => String(sha).slice(0, 8)).join('、')),
                ),
              /* 提交明细默认折叠：有数据时能再叠 400px 上下，而「几次提交」在统计行里已经有了。 */
              (coding.commits ?? []).length === 0 ? null : h('details', { 'data-coding-commits': '' },
                h('summary', { className: 'cursor-pointer text-caption-1-regular text-text-secondary' }, `提交 ${coding.commits.length} 次`),
                h('div', { className: 'mt-1 flex max-h-56 min-w-0 flex-col gap-1 overflow-auto pr-1' },
                  coding.commits.slice(0, 20).map(item => h('div', { key: item.id, className: LIST_LINE },
                    h('code', { className: CODE_CHIP }, item.sha.slice(0, 8)),
                    h('span', { className: GROW }, item.message || '(无提交说明)'),
                    h('span', { className: HINT }, `${item.files} 文件`),
                  )),
                  coding.commits.length > 20 ? h('div', { className: HINT }, `还有 ${coding.commits.length - 20} 次提交`) : null,
                )),
              /* 12 个文件以前铺成 4 行 chip（占全块 30% 高度），且「12 个文件 · +1563 −2」这个结论在界面上根本不存在。
                 现在：一行统计（增/删带色）+ 按改动量 Top3 + 展开全部（限高内滚）。 */
              (() => {
                const files = coding.files ?? []
                if (files.length === 0) return null
                const totals = files.reduce((acc, item) => ({
                  add: acc.add + (Number(item.additions) || 0),
                  del: acc.del + (Number(item.deletions) || 0),
                }), { add: 0, del: 0 })
                const byWeight = [...files].sort((a, b) => ((Number(b.additions) || 0) + (Number(b.deletions) || 0)) - ((Number(a.additions) || 0) + (Number(a.deletions) || 0)))
                const top = byWeight.slice(0, 3)
                const rowOf = item => h('div', { key: item.id, className: 'flex min-w-0 items-baseline gap-2' },
                  h('span', { className: 'min-w-0 truncate font-mono text-caption-1-regular text-text-primary', title: item.path }, item.path),
                  Number(item.additions) > 0 ? h('span', { className: 'shrink-0 tabular-nums text-caption-1-regular text-state-success-text' }, `+${item.additions}`) : null,
                  Number(item.deletions) > 0 ? h('span', { className: 'shrink-0 tabular-nums text-caption-1-regular text-text-error-primary' }, `−${item.deletions}`) : null,
                )
                return h('div', { className: 'flex min-w-0 flex-col gap-1', 'data-coding-files': '' },
                  h('div', { className: 'flex min-w-0 flex-wrap items-baseline gap-2 text-caption-1-regular' },
                    h('span', { className: 'text-text-secondary' }, `${files.length} 个文件`),
                    totals.add > 0 ? h('span', { className: 'tabular-nums text-state-success-text' }, `+${totals.add}`) : null,
                    totals.del > 0 ? h('span', { className: 'tabular-nums text-text-error-primary' }, `−${totals.del}`) : null,
                  ),
                  h('div', { className: 'flex min-w-0 flex-col gap-0.5' }, top.map(rowOf)),
                  files.length > top.length
                    ? h('details', { 'data-coding-files-rest': '' },
                      h('summary', { className: 'cursor-pointer text-caption-1-regular text-text-secondary' }, `展开其余 ${files.length - top.length} 个`),
                      h('div', { className: 'mt-1 flex max-h-56 min-w-0 flex-col gap-0.5 overflow-auto pr-1' }, byWeight.slice(3).map(rowOf)))
                    : null,
                )
              })(),
              coding.review.note === '' && coding.review.status === 'pending'
                ? null
                : h('div', { className: NOTE_BOX + ' text-text-primary', 'data-review-note': coding.review.status },
                  h('div', { className: 'text-caption-1-medium text-text-secondary' },
                    `评审意见${coding.review.by === '' ? '' : ` · ${coding.review.by}${coding.review.at > 0 ? ` · ${fmtTime(coding.review.at)}` : ''}`}`),
                  coding.review.note === ''
                    ? h('div', null, '（没有填写意见）')
                    : h('details', { 'data-review-note-full': '' },
                      h('summary', { className: 'cursor-pointer break-words' }, coding.review.note.length > 90 ? coding.review.note.slice(0, 90) + '…' : coding.review.note),
                      h('div', { className: 'mt-1 whitespace-pre-wrap break-words' }, coding.review.note))),
            ),
          codingDraft === null
            ? h('div', { className: ROW },
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: openCoding }, coding === null ? '手动补录执行记录' : '编辑执行记录'))
            : h('div', null,
              h('div', { className: ROW },
                h('div', { className: FIELD, style: { flex: 1 } },
                  tipLabel('Coding Agent', '这次改代码的 agent 名字，只作记录，不影响派单'),
                  h(TextField, { value: codingDraft.agent, placeholder: 'claude-code / codex / 自研', onChange: e => setCodingDraft({ ...codingDraft, agent: e.target.value }) }),
                ),
                h('div', { className: FIELD, style: { flex: 1 } },
                  h('div', { className: LABEL }, '模型'),
                  h(TextField, { value: codingDraft.model, placeholder: 'deepseek-v4.1-flash', onChange: e => setCodingDraft({ ...codingDraft, model: e.target.value }) }),
                ),
                h('div', { className: FIELD, style: { flex: 1 } },
                  h('div', { className: LABEL }, '分支'),
                  h(TextField, { value: codingDraft.branch, placeholder: 'feature/xxx', onChange: e => setCodingDraft({ ...codingDraft, branch: e.target.value }) }),
                ),
              ),
              h('div', { className: ROW },
                h('div', { className: FIELD, style: { flex: '0 0 110px' } },
                  tipLabel('单测总数', '这次执行报的单测总数，可以 agent 写回，也可以手填'),
                  h(TextField, { value: codingDraft.total, onChange: e => setCodingDraft({ ...codingDraft, total: e.target.value }) }),
                ),
                h('div', { className: FIELD, style: { flex: '0 0 110px' } },
                  tipLabel('通过数', '通过的条数；少于总数时卡片过不了准出'),
                  h(TextField, { value: codingDraft.passed, onChange: e => setCodingDraft({ ...codingDraft, passed: e.target.value }) }),
                ),
                h('div', { className: FIELD, style: { flex: 1 } },
                  h('div', { className: LABEL }, '这次依据的上下文'),
                  h(TextField, { value: codingDraft.context, placeholder: '例如 PRD v1.2 + 架构方案 v1', onChange: e => setCodingDraft({ ...codingDraft, context: e.target.value }) }),
                ),
              ),
              h('div', { className: ROW },
                h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveCoding() }, '保存执行记录'),
                h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setCodingDraft(null) }, '取消'),
              ),
            ),
        ),
      )
  )

  /* 执行记录页的六个区块：抽成具名函数后，顺序在调用处一眼可见（以前是 470 行内联 JSX）。 */
  const renderDiffSection = () => (
      h(Section, { pane: 'coding', current: pane, id: 'diff' },
        h(SectionHead, null, '代码改动（git diff）',
          h('span', { className: HINT }, '直接读仓库里的真实改动：卡的分支对比基线。左边文件树按目录分组，标了新增/修改/删除与行数')),
        h('div', { className: SECTION_BODY, 'data-drawer-diff': '' },
          (() => {
            if (diffBusy) return h('div', { className: HINT, 'data-diff-loading': '' }, '读取中…')
            if (diffError !== null) {
              return h('div', { className: ROW, style: { gap: 8, alignItems: 'center' } },
                h('div', { className: ERR_TEXT }, `读不到代码改动：${diffError}`),
                h(Button, { variant: 'ghost', size: 'sm', onClick: () => void loadDiff() }, '再试一次'))
            }
            if (diffView === null) {
              return h('div', { className: ROW, style: { gap: 8, alignItems: 'center' } },
                h(Button, { variant: 'secondary', size: 'sm', onClick: () => void loadDiff() }, '读取代码改动'),
                h('span', { className: HINT }, '从卡的 worktree（或项目代码目录）读分支相对基线的改动'))
            }
            if (String(diffView.skipped ?? '') !== '') return h(EmptyState, { title: diffView.skipped })
            if (diffView.ok !== true) return h(EmptyState, { title: '读不到代码改动' })
            const allFiles = Array.isArray(diffView.files) ? diffView.files : []
            const fileQuery = diffQuery.trim().toLowerCase()
            const files = fileQuery === '' ? allFiles : allFiles.filter(item => String(item.path).toLowerCase().includes(fileQuery))
            const totals = diffView.totals ?? { files: 0, additions: 0, deletions: 0 }
            const uncommitted = diffView.uncommitted ?? { total: 0, files: [], additions: 0, deletions: 0 }
            /* 文件树：目录分组 + 改动标记（新增/修改/删除）+ 行数；点一个文件在下面看它的 patch。 */
            const tree = buildDiffTree(files)
            const selected = files.find(item => item.path === diffPath) ?? files[0] ?? null
            const changeLabel = item => DIFF_CHANGE_LABEL[item.change] ?? '修改'
            const changeClass = item => DIFF_CHANGE_CLASS[item.change] ?? ''
            const renderNode = node => (node.kind === 'dir'
              ? h(TreeViewItem, { key: node.id, id: node.id, label: node.name, textValue: node.path, title: node.path }, node.children.map(renderNode))
              : h(TreeViewItem, {
                key: node.id,
                id: node.id,
                label: node.name,
                textValue: node.path,
                'data-diff-file': node.path,
                trailingContent: h('span', { className: 'flex items-center gap-2' },
                  h('span', { className: changeClass(node.file), 'data-change': node.file.change }, changeLabel(node.file)),
                  h('span', { className: 'text-state-success-text' }, `+${node.file.additions}`),
                  h('span', { className: 'text-text-error-primary' }, `−${node.file.deletions}`)),
              }))
            const renderLine = (line, index) => h('div', {
              key: `d-${index}`,
              className: line.startsWith('+++') || line.startsWith('---')
                ? 'text-text-tertiary'
                : line.startsWith('+')
                  ? 'text-state-success-text'
                  : line.startsWith('-')
                    ? 'text-text-error-primary'
                    : line.startsWith('@@')
                      ? 'text-accent-600'
                      : 'text-text-secondary',
            }, line === '' ? ' ' : line)
            /* 「全文」：读工作树里的文件本体（只读、200KB 上限），带行号。 */
            const renderFileView = item => {
              if (fileView === null || fileView.path !== item.path) return h('div', { className: HINT }, '读取文件全文…')
              if (fileView.busy === true) return h('div', { className: HINT, 'data-diff-fulltext-loading': '' }, '读取中…')
              if (fileView.error !== null) return h('div', { className: ERR_TEXT }, `读不到全文：${fileView.error}`)
              const data = fileView.data ?? {}
              if (String(data.skipped ?? '') !== '') return h('div', { className: HINT }, data.skipped)
              if (data.binary === true) return h('div', { className: HINT }, '二进制文件，不显示全文')
              const text = String(data.content ?? '')
              return h('pre', {
                className: 'max-h-[420px] overflow-auto rounded-md bg-background-secondary-default p-2 text-caption-1-regular',
                'data-diff-fulltext': item.path,
                style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 },
              },
                text.split('\n').map((line, index) => h('div', { key: `f-${index}`, className: 'flex gap-2 text-text-secondary' },
                  h('span', { className: 'shrink-0 select-none tabular-nums text-text-tertiary', style: { minWidth: '3em', textAlign: 'right' } }, String(index + 1)),
                  h('span', { className: 'min-w-0 whitespace-pre-wrap break-words' }, line === '' ? ' ' : line))),
                data.truncated === true ? h('div', { className: HINT }, '文件太大，只显示前 200 KB') : null)
            }
            return h('div', { className: 'flex min-w-0 flex-col gap-2' },
              h('div', { className: ROW, style: { gap: 8, alignItems: 'center' } },
                h(ChipField, { variant: 'gray', 'data-diff-range': '1' }, diffView.rangeLabel || `${diffView.branch || '(无分支)'} ← ${diffView.base}`),
                h('span', { className: HINT, 'data-diff-totals': `${totals.files}-${totals.additions}-${totals.deletions}` },
                  `${totals.files} 个文件 · +${totals.additions} −${totals.deletions}${diffView.truncated === true ? '（已截断）' : ''}`),
                (diffView.commits ?? []).length === 0
                  ? null
                  : h('div', { className: 'w-56 max-w-full', 'data-diff-commit': '' },
                    h(SelectField, {
                      value: diffCommit,
                      'aria-label': '看哪一次提交',
                      onChange: event => { setDiffCommit(event.target.value); setDiffQuery(''); void loadDiff(event.target.value) },
                    },
                      h('option', { value: '' }, '全部改动'),
                      diffView.commits.map(item => h('option', { key: item.sha, value: item.sha }, `${item.sha} ${String(item.subject).slice(0, 24)}`)))),
                allFiles.length > 6 || diffQuery !== ''
                  ? h('div', { className: 'w-40 max-w-full', 'data-diff-filter': '' },
                    h(TextField, { value: diffQuery, placeholder: '筛文件路径…', 'aria-label': '筛文件', onChange: event => {
                      const value = event.target.value
                      setDiffQuery(value)
                      const query = value.trim().toLowerCase()
                      const hit = allFiles.filter(item => query === '' || String(item.path).toLowerCase().includes(query))
                      setDiffPath(hit[0]?.path ?? '')
                      setFileView(null)
                    } }))
                  : null,
                h(Button, { variant: 'ghost', size: 'sm', disabled: diffBusy, onClick: () => void loadDiff() }, '刷新'),
                (task.gitlabMR?.url ?? '') === ''
                  ? null
                  : h('a', { className: LINK, href: String(task.gitlabMR.url).replace(/\/$/, '') + '/diffs', target: '_blank', rel: 'noreferrer' }, '在 GitLab 看 diff')),
              h('div', { className: HINT }, `仓库：${diffView.dir}`),
              uncommitted.total > 0
                ? h('div', { className: 'text-caption-1-regular text-status-yellow-text', 'data-diff-dirty': uncommitted.total },
                  `还有 ${uncommitted.total} 个文件没提交（+${uncommitted.additions} −${uncommitted.deletions}）：这些改动不在分支上，评审和测试都看不到`)
                : null,
              files.length === 0
                ? h('div', { className: HINT }, allFiles.length === 0 ? '这条分支相对基线没有代码改动。' : '没有匹配的文件。')
                : h('div', { className: 'min-w-0', 'data-diff-tree': '' },
                  h(TreeView, {
                    // 刷新（at 变了）就重建：新出现的目录也要按默认全部展开，避免沿用旧的展开集合。
                    key: `diff-tree-${diffView.at ?? ''}`,
                    'aria-label': '改动的文件（按目录分组）',
                    selectionMode: 'single',
                    selectedKeys: diffPath === '' ? [] : [diffPath],
                    defaultExpandedKeys: diffDirIds(tree),
                    onSelectionChange: keys => {
                      const next = Array.from(keys)
                      selectDiffFile(next.length > 0 ? String(next[0]) : '')
                    },
                    size: 'sm',
                    showGuides: true,
                    // 跟随上游「树跟着内容长、滚动交给外层」：不再套一层 280px 内滚动。
                    // 圆角与所在区块一致（上游默认 24px，套在 12px 的区块里会显得层级更深）。
                    style: { borderRadius: 12 },
                  }, tree.map(renderNode))),
              files.length === 0
                ? null
                : (selected === null
                  ? h('div', { className: HINT }, '在文件树里选一个文件，看它的改动内容。')
                  : h('div', { className: 'flex min-w-0 flex-col gap-2', 'data-diff-content': selected.path },
                    h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2' },
                      h('span', { className: 'font-mono text-caption-1-regular text-text-primary' }, selected.path),
                      h('span', { className: changeClass(selected), 'data-change': selected.change }, changeLabel(selected)),
                      h('span', { className: 'text-caption-1-regular text-state-success-text' }, `+${selected.additions}`),
                      h('span', { className: 'text-caption-1-regular text-text-error-primary' }, `−${selected.deletions}`),
                      selected.binary === true ? h('span', { className: HINT }, '二进制') : null,
                      selected.truncated === true ? h('span', { className: HINT }, '已截断') : null,
                      h('span', { className: GROW }),
                      h(Button, { variant: diffMode === 'diff' ? 'secondary' : 'ghost', size: 'sm', 'data-diff-mode': 'diff', onClick: () => setDiffMode('diff') }, '改动'),
                      h(Button, {
                        variant: diffMode === 'file' ? 'secondary' : 'ghost',
                        size: 'sm',
                        'data-diff-mode': 'file',
                        onClick: () => {
                          setDiffMode('file')
                          if (fileView === null || fileView.path !== selected.path) void loadFile(selected.path)
                        },
                      }, '全文'),
                      h(Button, { variant: 'ghost', size: 'sm', 'data-diff-copy': 'path', onClick: () => void copyPlain(selected.path, '路径') }, '复制路径'),
                      h(Button, { variant: 'ghost', size: 'sm', 'data-diff-copy': 'content', onClick: () => void copyPlain(diffMode === 'file' ? String(fileView?.data?.content ?? '') : selected.patch, diffMode === 'file' ? '全文' : 'diff') }, '复制内容')),
                    diffMode === 'file'
                      ? renderFileView(selected)
                      : (selected.patch === ''
                        ? h('div', { className: HINT }, '没有可显示的 patch（二进制文件或改动太大）')
                        : h('pre', { className: 'max-h-[420px] overflow-auto rounded-md bg-background-secondary-default p-2 text-caption-1-regular', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 } },
                          String(selected.patch).split('\n').map(renderLine))))),
              diffView.omitted > 0 ? h('div', { className: HINT }, `还有 ${diffView.omitted} 个文件没展开（改动太多）`) : null,
            )
          })(),
        ),
      )
  )

  /* 执行记录页的六个区块：抽成具名函数后，顺序在调用处一眼可见（以前是 470 行内联 JSX）。 */
  const renderMergeGateSection = () => (
      h(Section, { pane: 'coding', current: pane, id: 'merge-gate' },
        h(SectionHead, null, '合并门禁',
          h('span', { className: HINT }, '把「能不能合」发成 GitLab 的 studio/merge-gate 提交状态；仓库要求状态检查时必须通过，合并按钮才会放行')),
        h('div', { className: SECTION_BODY },
          mergeGate === null
            ? null
            : h('div', { className: PANEL },
              h('div', { className: PANEL_HEAD },
                h(ChipField, {
                  variant: 'gray',
                  'data-review': mergeGate.state === 'success' ? 'approved' : 'changes_requested',
                }, mergeGate.state === 'success' ? '通过' : '不通过'),
                h('div', { className: GROW },
                  h('div', { className: PANEL_LINE }, `${mergeGate.name} @ ${String(mergeGate.sha ?? '').slice(0, 8)}`),
                  h('div', { className: HINT }, `${fmtTime(mergeGate.at)} · ${mergeGate.by || '人'}${mergeGate.error === '' ? '' : ` · ${mergeGate.error}`}`),
                ),
                h('span', { className: HINT }, `MR !${mergeGate.iid}`),
              ),
              (mergeGate.blockers ?? []).length === 0
                ? null
                : h('div', { className: HINT, 'data-warn': '1', style: { marginTop: 8 } },
                  mergeGate.blockers.slice(0, 5).map((item, index) => h('div', { key: 'mg-' + index }, `· ${item}`))),
            ),
          h('div', { className: ROW, style: { gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy || mergeRun.busy, onClick: () => void syncMergeGate() },
              mergeRun.busy ? '发布中…' : '同步合并门禁'),
            h(Button, {
              variant: 'secondary', size: 'sm',
              disabled: busy || mergeRun.busy || mergeGate === null || mergeGate.state !== 'success',
              title: '门禁通过后由平台调用 GitLab 的 merge API。GitLab CE 拦不住人工点合并（没有外部状态检查），所以合并走这里才受管辖',
              onClick: () => void mergeNow(),
            }, '合并 MR'),
            h('span', { className: HINT }, '需要卡片关联 MR、且配了 GitLab 项目。'),
          ),
          mergeRun.line === '' ? null : h('div', { className: HINT, style: { marginTop: 8 } }, mergeRun.line),
        ),
      )
  )

  /* 执行记录页的六个区块：抽成具名函数后，顺序在调用处一眼可见（以前是 470 行内联 JSX）。 */
  const renderQualitySection = () => (
      h(Section, { pane: 'coding', current: pane, id: 'quality' },
        h(SectionHead, null, '项目检查',
          h('span', { className: HINT }, '在这个项目的代码目录（有 worktree 就用它）里跑一条本地质量命令')),
        h('div', { className: SECTION_BODY },
          (() => {
            const project = (state.config?.projects ?? []).find(item => item.id === task.project)
            const services = project?.services ?? []
            const service = services.find(item => item.id === task.service) ?? (services.length === 1 ? services[0] : undefined)
            const cmd = String(service?.qualityCmd ?? '').trim() || String(project?.qualityCmd ?? '').trim()
            if (cmd === '') {
              return h(EmptyState, { title: '这个项目还没配检查命令。到「设置 → 平台 → 项目」填一条（如 npm run check）；配了以后，改过代码的卡要跑过它才能收口。' })
            }
            return h('div', { className: PANEL },
              h('div', { className: PANEL_HEAD },
                h(ChipField, {
                  variant: 'gray',
                  'data-review': quality === null ? 'pending' : (quality.ok === true ? 'approved' : 'changes_requested'),
                }, quality === null ? '没跑过' : (quality.ok === true ? '通过' : '不通过')),
                h('div', { className: GROW },
                  h('div', { className: PANEL_LINE }, cmd),
                  quality === null
                    ? null
                    : h('div', { className: HINT },
                      `${fmtTime(quality.at)} · ${quality.by || '人'} · ${(Number(quality.ms) || 0) / 1000}s` +
                      (quality.exitCode === null ? '' : ` · 退出码 ${quality.exitCode}`) +
                      (quality.timedOut === true ? ' · 超时' : '') +
                      (quality.cwd ? ` · ${quality.cwd}` : '')),
                ),
                h(Button, { variant: 'ghost', size: 'sm', disabled: busy || qualityRun.busy, onClick: () => void runQuality() },
                  qualityRun.busy ? '跑检查中…' : (quality === null ? '跑一次' : '再跑一次')),
              ),
              qualityRun.line === ''
                ? null
                : h('div', { className: HINT, 'data-quality': quality?.ok === true ? 'ok' : 'bad', style: { marginTop: 8 } }, qualityRun.line),
              quality === null || quality.output === ''
                ? null
                : h('pre', {
                  className: HINT,
                  'data-quality': quality.ok === true ? 'ok' : 'bad',
                  style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflow: 'auto', margin: '6px 0 0' },
                }, String(quality.output).slice(-1500)),
            )
          })(),
        ),
      )
  )

  /* 执行记录页的六个区块：抽成具名函数后，顺序在调用处一眼可见（以前是 470 行内联 JSX）。 */
  const renderFeedSection = () => (feedCount === 0 ? null : (
      h(Section, { pane: 'coding', current: pane, id: 'feed' },
        h(SectionHead, null, '执行播报',
          h('span', { className: HINT }, '派单会话在跑时的机器进度（工具 / 模型 / 回复摘要）。它不再写进讨论区——讨论区只留人和专家的评论')),
        h('div', { className: SECTION_BODY, 'data-drawer-feed': '' },
          (feedList.length === 0)
            ? h('div', { className: HINT }, '这张卡还没有播报。派单会话跑起来后，这里会显示最近的机器进度。')
            : h('div', { className: 'flex flex-col gap-2' },
              ...feedList.slice().reverse().map((entry, index) => h('div', {
                key: `${entry.at}-${index}`,
                className: 'flex min-w-0 flex-col gap-1 rounded-lg bg-background-secondary-default px-3 py-2',
                'data-feed-entry': '',
              },
                h('div', { className: 'flex min-w-0 items-center gap-2 text-caption-1-regular text-text-tertiary' },
                  h('span', null, fmtTime(entry.at)),
                  entry.expert ? h('span', { className: 'min-w-0 truncate' }, entry.expert) : null),
                h('div', { className: 'whitespace-pre-wrap break-words text-caption-1-regular text-text-primary', style: { maxHeight: 200, overflow: 'auto' } }, String(entry.text ?? '')))),
              feedCount > feedList.length
                ? h('div', { className: HINT }, `只显示最近 ${feedList.length} 条，共 ${feedCount} 条`)
                : null),
        ),
      )
  )
)

  /* 执行记录页的六个区块：抽成具名函数后，顺序在调用处一眼可见（以前是 470 行内联 JSX）。 */
  const renderSkillSection = () => (task.status !== 'accept' && task.status !== 'done' ? null : (
      h(Section, { pane: 'coding', current: pane, id: 'skill' },
        h(SectionHead, null, '技能沉淀',
          h('span', { className: HINT }, '把这张卡上真实发生过的证据汇总成一条技能草稿（默认停用）')),
        h('div', { className: SECTION_BODY },
          h('div', { className: ROW, style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy || mine.busy, onClick: () => void mineSkill() },
              mine.busy ? '汇总中…' : '把这张卡沉淀成技能'),
            h('span', { className: HINT }, '只搬已有的验收锚点、跑过的命令、踩过的坑，不做推断；没有证据的卡不给沉淀。'),
          ),
          mine.line === '' ? null : h('div', { className: HINT, style: { marginTop: 8 } }, mine.line),
        ),
      )
  )
)

  const columnLabel = (state.statuses.find(item => item.id === task.status) ?? {}).label ?? task.status
  const assignee = task.dispatch?.expert ? ownerLabel(state.config ?? {}, { kind: 'expert', id: task.dispatch.expert }) : ''
  return h('div', {
    className: 'fixed inset-0 z-[60] flex justify-end bg-black/40',
    style: { top: 'max(env(titlebar-area-height, 0px), var(--ds-titlebar-floor, 0px))', WebkitAppRegion: 'no-drag' },
    'data-drawer-overlay': '',
    onClick: event => { if (event.target === event.currentTarget) onClose() },
  },
    h('div', {
      className: 'flex h-full max-h-full flex-col overflow-hidden border-l border-separator-border bg-background-primary-default text-text-primary shadow-2xl',
      style: { width: 'min(980px, 94vw)' },
      ref: drawerRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `卡片详情：${task.title || task.id}`,
      tabIndex: -1,
      'data-drawer': '',
    },
      h('div', { className: 'flex shrink-0 items-start gap-2 border-b border-separator-border px-5 pt-4 pb-3' },
        h('div', { className: GROW },
          h('div', { className: 'text-title-1-semibold break-words text-text-primary' }, task.title),
          h('div', { className: 'mt-1 ' + HINT }, `${task.id} · ${columnLabel}${assignee === '' ? '' : ` · ${assignee}`} · 更新 ${fmtTime(task.updatedAt)}`),
        ),
        h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: '定案 + 评审通过才能进开发', onClick: () => setPane('design') }, '设计：' + (DESIGN_LABEL[task.design?.status] ?? '未登记') + (designDrafts.length > 0 ? `（${designDrafts.length} 稿）` : '')),
        h(Button, { variant: 'secondary', size: 'sm', onClick: onClose }, '关闭'),
        (Number(task.agentFailures) || 0) > 0
          ? tipOf(
            task.retryAt > 0 ? `下一次自动重试：${fmtTime(task.retryAt)}` : '失败次数已用完，重置后可以重新派单',
            h(Button, {
              variant: 'secondary',
              size: 'sm',
              disabled: busy,
              'data-agent-failed': '1',
              onClick: () => void retryAgent(),
            }, `AI 失败 ${Number(task.agentFailures) || 0} 次 · 重新派单`),
          )
          : null,
      ),
      (kit('TabsBar') !== null
        ? h(kit('TabsBar'), {
            items: tabs.map(tab => ({ id: tab.id, label: tab.label, count: tab.count })),
            value: pane,
            onChange: next => setPane(next),
          })
        : h('div', { className: 'flex shrink-0 flex-wrap items-center gap-1 border-b border-separator-border px-5 pt-3', 'data-drawer-tabs': '' },
          tabs.map(tab => h('button', {
            key: tab.id,
            'data-on': pane === tab.id ? '1' : '0',
            'data-drawer-tab': tab.id,
            className: 'flex items-center gap-1 rounded-t-lg border-x border-t px-3 py-2 text-body-2-medium '
              + (pane === tab.id
                ? 'border-separator-border bg-background-primary-default font-semibold text-text-primary'
                : 'border-transparent text-text-secondary hover:bg-background-secondary-hover'),
            onClick: () => setPane(tab.id),
          }, tab.label, tab.count === '' || tab.count === undefined || tab.count === null
            ? null
            : h('span', { className: 'rounded-sm bg-background-secondary-default px-1 text-caption-1-medium tabular-nums' }, String(tab.count)))),
        )),
      h('div', { className: 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pt-4 pb-6', ref: bodyRef, 'data-pane': pane },
      h('div', { className: 'flex flex-wrap items-center gap-2 text-caption-1-regular text-text-tertiary', 'data-drawer-meta': '' },
        h(ChipField, { variant: 'gray' }, task.id),
        task.type === 'bug'
          ? h(ChipField, { variant: 'rose', 'data-sev': task.severity ?? 'p2' }, `BUG ${String(task.severity || 'p2').toUpperCase()}`)
          : h(ChipField, { variant: 'gray' }, TYPE_LABEL[task.type] ?? task.type),
        h(ChipField, { variant: 'gray' }, `当前列：${state.statuses.find(c => c.id === task.status)?.label ?? task.status}`),
        h(ChipField, {
          variant: 'gray',
          'data-role': (task.dispatch?.state === 'running' && task.dispatch?.expert) ? undefined : task.role,
          'data-open': cardOwner(task, state.config ?? {}).label === '未指派' ? '1' : '0',
          title: cardOwner(task, state.config ?? {}).note,
        }, `负责：${cardOwner(task, state.config ?? {}).label}`),
        task.type === 'bug'
          ? h(SelectField, {
            style: { height: 20, fontSize: 11, padding: '0 4px' }, value: task.severity || 'p2',
            title: '严重级别', onChange: event => void push({ severity: event.target.value }),
          }, ['p0', 'p1', 'p2', 'p3'].map(value => h('option', { key: value, value }, SEVERITY_LABEL[value])))
          : null,
        h(ChipField, { variant: 'gray' }, PRIORITY_LABEL[task.priority] ?? task.priority),
        h(ChipField, {
          variant: 'gray', title: '点一下改业务领域（决定派给同领域专家）', style: { cursor: 'pointer' },
          onClick: async () => {
            const next = await promptDialog('业务领域（如 支付 / 风控 / 会员），留空表示不限', { title: '改业务领域', defaultValue: task.domain || '' })
            if (next !== null) void push({ domain: next })
          },
        }, task.domain ? `领域：${task.domain}` : '领域：未标'),
        h('span', {}, `创建 ${fmtTime(task.createdAt)}`),
        h('span', {}, `更新 ${fmtTime(task.updatedAt)}`),
      ),
      h('div', { className: 'flex min-w-0 flex-col gap-4' },
        h('div', { className: 'flex min-w-0 flex-col gap-4' },
      h(Section, { pane: 'overview', current: pane, id: 'advance' },
        h(SectionHead, null, '推进到', h('span', { className: HINT }, '点一下就会移动卡片，并触发对应列的 AI')),
        h('div', { className: ACTIONS }, (() => {
          const order = state.statuses
          const currentIndex = order.findIndex(item => item.id === task.status)
          const forward = order[currentIndex + 1] ?? null
          const rest = order.filter(item => item.id !== task.status && (forward === null || item.id !== forward.id))
          const later = rest.filter(item => order.findIndex(o => o.id === item.id) > currentIndex)
          const earlier = rest.filter(item => order.findIndex(o => o.id === item.id) < currentIndex)
          return [
            forward === null
              ? null
              : h(Button, {
                key: 'next', variant: 'primary', size: 'sm', disabled: busy,
                title: '推进到下一列，下一列的 AI 会接手',
                onClick: () => void advanceTo(forward.id, forward.role),
              }, `推进到「${forward.label}」`),
            rest.length === 0 ? null : h(SelectField, {
              key: 'other', value: '', disabled: busy,
              onChange: event => {
                const id = event.target.value
                if (id === '') return
                const target = order.find(item => item.id === id)
                if (target !== undefined) void advanceTo(target.id, target.role)
              },
            },
              h('option', { value: '' }, `其他状态（${rest.length}）`),
              ...later.map(item => h('option', { key: item.id, value: item.id }, `→ ${item.label}`)),
              ...earlier.map(item => h('option', { key: item.id, value: item.id }, `← ${item.label}（退回，AI 会重跑）`)),
            ),
          ].filter(Boolean)
        })()),
      ),
      h(Section, { pane: 'overview', current: pane, id: 'collab' },
        h(SectionHead, null, '协作链',
          h('span', { className: HINT }, '四个角色接力：产品挖需求与验收 → 架构出方案 → 研发实现并自测 → 测试按三层验；缺哪一棒一眼看到')),
        h('div', { className: SECTION_BODY, 'data-role-chain': '' },
          (() => {
            const parent = (state.tasks ?? []).find(item => item.id === task.parent) ?? null
            const row = productChainRow({ task, requirement: collabRequirement, parent })
            return roleRow('product', '产品', row.tone, row.chip, row.detail)
          })(),
          (() => {
            if (collabDesign === null) return roleRow('architect', '架构', 'missing', '未登记方案', '让架构师出方案（多稿 + 定案 + 评审）')
            const label = { pending: '待评审', approved: '评审通过', changes_requested: '要求修改' }[String(collabDesign.status ?? '')] ?? '未登记'
            const detail = `${label} · ${collabDrafts.length} 稿`
            if (collabDesign.status === 'approved' && collabChosen !== null) return roleRow('architect', '架构', 'ok', '方案已定案', `${detail} · 定案「${collabChosen.name}」`)
            return roleRow('architect', '架构', 'warn', collabChosen === null ? '方案未定案' : '方案待评审', detail)
          })(),
          (() => {
            if (collabCoding === null) return roleRow('dev', '研发', 'missing', '没有执行记录', '研发还没登记 studio_task_coding')
            const bits = [
              collabCoding.branch ? `分支 ${collabCoding.branch}` : '',
              `${(collabCoding.commits ?? []).length} 提交`,
              `${(collabCoding.files ?? []).length} 文件`,
              `单测 ${collabCoding.unitTests?.passed ?? 0}/${collabCoding.unitTests?.total ?? 0}`,
              collabQuality === null ? '项目检查未跑' : `项目检查${collabQuality.ok === true ? '通过' : '未过'}`,
            ].filter(Boolean).join(' · ')
            const review = String(collabCoding.review?.status ?? '')
            /* 评审意见以前只在「执行记录」页签里，概览这里只写「实现已评审」四个字；
               把评审人与意见摘要带出来，人不必再翻页签才知道架构师说了什么。 */
            const reviewBy = String(collabCoding.review?.by ?? '').trim()
            const reviewNote = String(collabCoding.review?.note ?? '').trim()
            const reviewDetail = `${reviewBy === '' ? '' : ` · 评审人 ${reviewBy}`}${reviewNote === '' ? '' : ` · 评审意见：${reviewNote.slice(0, 80)}${reviewNote.length > 80 ? '…' : ''}`}`
            if (review === 'approved') return roleRow('dev', '研发', 'ok', '实现已评审', `${bits}${reviewDetail}`)
            if (review === 'changes_requested') return roleRow('dev', '研发', 'bad', '评审要改', `${bits}${reviewDetail}`)
            return roleRow('dev', '研发', 'warn', '实现待评审', bits)
          })(),
          (() => {
            if (parts === null) return roleRow('qa', '测试', 'missing', '载入中', '')
            if (collabPlanRows.length === 0) return roleRow('qa', '测试', 'missing', '没有用例', '测试还没登记用例')
            const detail = collabPlanRows.map(row => `${CASE_TIER_LABEL[row.tier] ?? row.tier} ${row.pass}/${row.total}${row.applicable === false ? '（不适用）' : ''}`).join(' · ')
            if (collabGaps.length > 0) return roleRow('qa', '测试', 'warn', `缺 ${collabGaps.join('/')}`, detail)
            return roleRow('qa', '测试', 'ok', '三层已覆盖', detail)
          })(),
        ),
      ),
      h(Section, { pane: 'overview', current: pane, id: 'gate' },
        h(SectionHead, null, '准出检查',
          h('span', { className: HINT }, '进「已完成」之前必须过这一关：清单全勾、没有失败用例、不在阻塞、有人签字')),
        h('div', { className: SECTION_BODY },
          gate === null
            ? h('div', { className: ROW, style: { gap: 8, alignItems: 'center' } },
                h(Button, { variant: 'secondary', size: 'sm', onClick: () => void checkGate() }, '检查一下'),
                h('span', { className: HINT }, '点一下看这张卡还差什么才能收口'))
            : h('div', {
                className: EMPTY_BOX + (gate.ready ? ' border-separator-border-strong' : ' border-border-error-default'),
                'data-ready': gate.ready ? '1' : '0',
                'data-drawer-gate': '',
              },
                h('div', { className: 'flex min-w-0 flex-wrap items-center justify-between gap-2 text-body-2-semibold text-text-primary' },
                  h('b', null, gate.ready ? '可以进「已完成」' : `还差 ${gate.blockers.length} 项`),
                  h(Button, { variant: 'ghost', size: 'sm', onClick: () => void checkGate() }, '重新检查')),
                (gate.blockers ?? []).map(line => h('div', { key: line, className: 'text-caption-1-regular text-text-error-primary', 'data-kind': 'block' }, `${line}`)),
                (gate.warnings ?? []).map(line => h('div', { key: line, className: 'text-caption-1-regular text-text-secondary', 'data-kind': 'warn' }, `${line}`)),
                (gate.blockers ?? []).length === 0 && (gate.warnings ?? []).length === 0
                  ? h('div', { className: HINT }, '没有遗留项。') : null),
          task.signoff === null || task.signoff === undefined
            ? h('div', { className: 'flex min-w-0 flex-col gap-2' },
                h('div', { className: ROW, style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h(TextField, {
                    style: { flex: '1 1 260px' },
                    value: gateNote,
                    placeholder: '验收签字：验了什么、遗留什么',
                    onChange: event => setGateNote(event.target.value),
                  }),
                  h(Button, {
                    variant: 'primary',
                    size: 'sm',
                    /* 空结论点下去服务端会 400「验收签字要写一句结论」，人只会觉得“点了没反应”，所以先禁用。 */
                    disabled: busy || pendingChildren.length > 0 || gateNote.trim() === '',
                    title: pendingChildren.length > 0 ? '先收口子卡' : (gateNote.trim() === '' ? '先写一句验收结论' : '以你本人的身份签字（AI 代签不计入）'),
                    onClick: () => void signOff('sign'),
                  }, '签字确认')),
                gateNote.trim() === '' && pendingChildren.length === 0
                  ? h('div', { className: HINT, 'data-signoff-hint': '' }, '先在上面写一句验收结论（验了什么、遗留什么），「签字确认」才会亮。')
                  : null,
                pendingChildren.length > 0
                  ? h('div', { className: 'flex min-w-0 flex-col gap-1 rounded-lg bg-background-secondary-default p-2', 'data-pending-children': '' },
                      h('div', { className: 'text-caption-1-regular text-text-warning-primary' }, '子卡没到「已完成」之前主卡签不了。做法：打开下面那张子卡，点它顶部的「推进到「已完成」」。'),
                      h('div', { className: 'flex flex-wrap items-center gap-2' },
                        pendingChildren.map(item => h(Button, {
                          key: item.id,
                          variant: 'secondary',
                          size: 'sm',
                          disabled: typeof onOpenTask !== 'function',
                          onClick: () => { if (typeof onOpenTask === 'function') onOpenTask(item.id) },
                        }, `打开 ${item.code || item.id}（${statusLabelOf(item.status)}）`))))
                  : null,
                error !== null ? h('div', { className: ERR_TEXT, 'data-signoff-error': '' }, error) : null)
            : h('div', { className: 'flex min-w-0 flex-col gap-2 rounded-xl bg-background-secondary-default p-3 text-caption-1-regular text-text-primary', 'data-drawer-signoff': '', 'data-signoff-actor': String(task.signoff.actorKind ?? '') },
                h('div', { className: 'flex min-w-0 flex-wrap items-center justify-between gap-2' },
                  h('span', { className: 'min-w-0 break-words' }, `${task.signoff.by} 于 ${fmtTime(task.signoff.at)} 签字：${task.signoff.note}`),
                  h(Button, { variant: 'ghost', size: 'sm', onClick: () => void signOff('clear') }, '取消签字')),
                ['agent', 'ai'].includes(String(task.signoff.actorKind ?? ''))
                  ? h('div', { className: 'flex min-w-0 flex-col gap-2', 'data-ai-signoff': '' },
                    h('span', { className: 'text-caption-1-regular text-text-warning-primary' }, '这是 AI 代签（actorKind=agent）：准出只认人工签字。在下面写一句结论直接签即可覆盖这条——两条都会留在历史里，不用先点「取消签字」。'),
                    h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2' },
                      h(TextField, {
                        style: { flex: '1 1 220px' },
                        value: gateNote,
                        placeholder: '验收签字：验了什么、遗留什么',
                        'aria-label': '覆盖 AI 签字：验收结论',
                        onChange: event => setGateNote(event.target.value),
                      }),
                      h(Button, {
                        variant: 'primary',
                        size: 'sm',
                        disabled: busy || gateNote.trim() === '',
                        title: gateNote.trim() === '' ? '先写一句验收结论' : '以你本人的身份签字（会覆盖上面那条 AI 签字）',
                        'data-signoff-override': '',
                        onClick: () => void signOff('sign'),
                      }, '以我的身份重新签字')))
                  : null),
        ),
      ),
      /* 重复缺陷：以前卡面只显示一个「重复」徽标，人想标重复只能去调工具。
         同一件事被自动开了两张缺陷时，在这里指认主缺陷（另一张会被关掉并互相留评论）。 */
      task.type === 'bug'
        ? h(Section, { pane: 'overview', current: pane, id: 'duplicate' },
          h(SectionHead, null, '重复缺陷',
            h('span', { className: HINT }, '和另一张缺陷是同一件事时在这里指认：被指认的那张会被关掉')),
          h('div', { className: SECTION_BODY },
            task.duplicateOf
              ? h('div', { className: ACTIONS },
                h('span', { className: HINT, 'data-duplicate-of': task.duplicateOf }, `重复于 ${(state.tasks ?? []).find(item => item.id === task.duplicateOf)?.code || task.duplicateOf}`),
                h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void markDuplicate('') }, '取消重复标记'))
              : h('div', { className: ACTIONS },
                h(Button, {
                  variant: 'ghost', size: 'sm', disabled: busy, 'data-mark-duplicate': '',
                  onClick: () => void markDuplicate(),
                }, '标为重复…'),
                h('span', { className: HINT }, '会请你填主缺陷的编号或 id；主缺陷保留，这张被标成重复并关闭'))),
        )
        : null,
      h(Section, { pane: 'overview', current: pane, id: 'blocked' },
        h(SectionHead, null, '阻塞',
          h('span', { className: HINT }, '卡住了打个标，卡留在本列停住，不会被自动往下派；怎么继续由人定')),
        blocked === null
          ? h('div', { className: SECTION_BODY },
            h('div', { className: HINT }, '缺信息、缺权限、等外部依赖、测试过不去——都可以标阻塞，别硬编。'),
            h('div', { className: ACTIONS },
              h(Button, { variant: 'ghost', size: 'sm', 'data-warn': '1', disabled: busy, onClick: () => void markBlocked() }, '标记阻塞'),
            ),
          )
          : h('div', { className: SECTION_BODY },
            h('div', { className: 'flex min-w-0 flex-col gap-1 rounded-xl border border-border-error-default bg-background-secondary-default p-3', 'data-drawer-blocked': '' },
              h('div', { className: 'text-body-2-semibold text-text-error-primary' }, `${blocked.reason || '未填写原因'}`),
              h('div', { className: HINT }, `${blocked.by || '人'} · ${fmtTime(blocked.at)} · 停在「${state.statuses.find(c => c.id === task.status)?.label ?? task.status}」`),
            ),
            h('div', { className: HINT }, '怎么继续：'),
            h('div', { className: ACTIONS },
              h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void resolveBlocked('resume') }, '继续，交本列负责人'),
              h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => void resolveBlocked('advance') }, '推进到下一列'),
              h(SelectField, {
                style: { width: 190 }, value: picked, disabled: busy,
                onChange: e => setPicked(e.target.value),
              },
                h('option', { value: '' }, '选一个专家…'),
                (state.config?.experts ?? []).filter(expert => expert.enabled !== false).map(expert =>
                  h('option', { key: expert.id, value: expert.id }, expert.name)),
              ),
              h(Button, { variant: 'secondary', size: 'sm', disabled: busy || picked === '', onClick: () => void resolveBlocked('assign', picked) }, '改派给他'),
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void resolveBlocked('clear') }, '只解除，先不派'),
            ),
          ),
      ),
      h(Section, { pane: 'overview', current: pane, id: 'agent' },
        h(SectionHead, null, 'AI 处理', h('span', { className: HINT }, '默认用本列负责人；也可以临时换人')),
        h('div', { className: SECTION_BODY },
          h('div', { className: HINT },
            task.dispatch?.state === 'running'
              ? `${ownerLabel(state.config ?? {}, { kind: 'expert', id: task.dispatch.expert ?? task.dispatch.role }) || 'AI'} 处理中 · 起于 ${fmtTime(task.dispatch.at)}`
              : task.dispatch?.state === 'failed'
                ? `上次派单失败：${task.dispatch.error ?? '未知原因'}`
                : task.dispatch?.state === 'stopped'
                  ? `上次派单已被停止（${fmtTime(task.dispatch.at)} · ${String(task.dispatch.by ?? '未记录谁停的')}；重启也不会自己接着跑，点「马上处理」继续）`
                  : task.dispatch?.state === 'done'
                    ? (task.dispatch.advanced === true
                        ? `上一轮已结束并推进到下一列 · ${ownerLabel(state.config ?? {}, { kind: 'expert', id: task.dispatch.expert ?? '' }) || 'AI'}`
                        : `上一轮已结束但没有换列（第 ${Number(task.dispatch.attempts) || 1} 次）：冷却后平台会自动再派一次，次数用完挂阻塞等补指令`)
                    : '这张卡还没有派给 AI'),
          policy === null ? null : (() => {
            const cfg = policy.configured ?? {}
            const expertId = (picked.startsWith('expert:') ? picked.slice('expert:'.length) : picked) || task.dispatch?.expert || task.expert || ''
            const expert = (state.config?.experts ?? []).find(item => item.id === expertId)
            /* 与 src/host/escalation.js 的 effectiveSandbox 同一口径：
               提权审批=自动批准 → 会话直接以完全权限（danger-full-access）运行；
               自动拒绝才把沙箱当边界用；专家的只读设置永远优先。 */
            const wanted = String(expert?.sandbox ?? '').trim() || String(cfg.sandbox ?? '').trim() || 'workspace-write'
            const configuredSandbox = ['read-only', 'danger-full-access', 'workspace-write'].includes(wanted) ? wanted : 'workspace-write'
            const allow = String(cfg.escalation ?? 'allow') !== 'deny'
            const sandbox = configuredSandbox === 'read-only' ? 'read-only' : (allow ? 'danger-full-access' : configuredSandbox)
            const forced = String(cfg.isolation ?? '') === 'worktree' && sandbox !== 'danger-full-access'
            const label = value => value === 'read-only' ? '只读' : value === 'danger-full-access' ? '无沙箱' : '只写工作区'
            const live = (policy.live ?? []).find(item => item.taskId === task.id)
            return h('div', { className: 'flex min-w-0 flex-col gap-1' },
              h('div', { className: HINT, 'data-dispatch-policy': '' },
                `本次派单：沙箱 ${label(forced ? 'danger-full-access' : sandbox)}${configuredSandbox === 'read-only' ? '（专家设为只读）' : forced ? '（worktree 隔离自动提权）' : allow ? '（自动批准 = 完全权限）' : ''} · 提权审批 ${allow ? '自动批准（直接完全权限运行）' : '自动拒绝（只做沙箱内的事）'}${live?.preset ? ` · 本会话实际 ${label(String(live.preset))}` : ''}`),
              h('div', { className: HINT }, '只对 Studio 派单的会话生效；你在侧栏手动新开的会话仍按 DSH 自己的权限档位。'))
          })(),
          h('div', { className: FIELD, style: { marginTop: 4 } },
            h('div', { className: LABEL }, '派给谁'),
            h(SelectField, {
              value: picked, disabled: busy,
              onChange: e => setPicked(e.target.value),
            },
              h('option', { value: '' }, '用本列负责人'),
              (state.config?.experts ?? []).filter(expert => expert.enabled !== false).map(expert =>
                h('option', { key: expert.id, value: `expert:${expert.id}` }, expert.name)),
              (state.config?.teams ?? []).filter(team => team.enabled !== false).map(team =>
                h('option', { key: team.id, value: `team:${team.id}` }, `👥 ${team.name}（团长接活）`)),
            ),
          ),
          h('div', { className: FIELD, style: { marginTop: 4 } },
            h('div', { className: LABEL }, '开场白（可选）'),
            h(TextField, {
              value: dispatchNote, disabled: busy,
              placeholder: '这次先做什么 / 不要动哪些文件',
              onChange: e => setDispatchNote(e.target.value),
            }),
          ),
          h('div', { className: ACTIONS, style: { marginTop: 8 } },
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void runAgent() }, '马上处理'),
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy || task.dispatch?.state !== 'running', onClick: () => void stopAgent() }, '停止'),
          ),
        ),
      ),
      h(Section, { pane: 'content', current: pane, id: 'content' },
        h(SectionHead, null, '内容'),
      h('div', { className: FIELD },
        h('div', { className: LABEL }, '标题'),
        h(TextField, { value: draft.title, onChange: e => setDraft({ ...draft, title: e.target.value }) }),
      ),
      h('div', { className: FIELD },
        h('div', { className: LABEL }, '需求 / 背景 / 验收标准'),
        String(draft.requirement ?? '').trim() === ''
          ? null
          : h('div', { className: 'md-content min-h-[84px] overflow-auto rounded-xl border border-separator-border bg-background-primary-default px-3 py-2', 'data-task-md': '1', style: { maxHeight: 220 } }, renderMarkdown(draft.requirement)),
        h(MdField, {
          rows: String(draft.requirement ?? '').trim() === '' ? 4 : 8,
          value: draft.requirement,
          placeholder: '这张卡要解决什么、背景是什么、做到什么算完成——AI 接手前最好写清楚。',
          onChange: e => setDraft({ ...draft, requirement: e.target.value }),
        }),
        String(draft.requirement ?? '').trim() === ''
          ? h('div', { className: HINT }, '这张卡还没有需求描述：专家只能按标题猜。补完点下面的「保存改动」。')
          : null,
      ),
      h('div', { className: FIELD },
        h('div', { className: LABEL }, '对应功能点'),
        (() => {
          const req = (state.requirements ?? []).find(item => item.id === task.requirementId)
          if (req === undefined) return h('div', { className: HINT }, '这张卡还没挂需求，先在「计划」里挂到某个需求，才能选功能点。')
          const points = req.points ?? []
          if (points.length === 0) return h('div', { className: HINT }, `需求 ${req.code || req.id} 还没拆功能点，去需求页「功能点与可追溯矩阵」加几条。`)
          return h(SelectField, {
            value: draft.pointId ?? '',
            onChange: event => setDraft({ ...draft, pointId: event.target.value }),
          },
            h('option', { value: '' }, '不归到具体功能点'),
            points.map(point => h('option', { key: point.id, value: point.id }, `${point.id} ${point.title}`)),
          )
        })(),
      ),
      h('div', { className: ROW },
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, 'GitLab Issue'),
          h(TextField, { value: draft.gitlabIssue, onChange: e => setDraft({ ...draft, gitlabIssue: e.target.value }) }),
        ),
        h('div', { className: FIELD, style: { flex: 1 } },
          h('div', { className: LABEL }, 'GitLab MR'),
          (task.gitlabMR?.iid ?? 0) > 0
            ? h('div', { className: 'flex min-w-0 items-center gap-2', 'data-drawer-mr': '' },
                h(ChipField, { variant: 'gray', 'data-on': task.gitlabMR.state === 'opened' ? '1' : undefined }, `MR !${task.gitlabMR.iid} · ${task.gitlabMR.state}`),
                h('div', { className: GROW },
                  h('div', { className: ART_TITLE }, task.gitlabMR.title || `MR !${task.gitlabMR.iid}`),
                  task.gitlabMR.url === '' ? null : h('div', { className: ART_REF }, task.gitlabMR.url),
                  (task.gitlabMR.sourceBranch ?? '') === '' ? null : h('div', { className: ART_REF }, `分支 ${task.gitlabMR.sourceBranch} → ${task.gitlabMR.targetBranch || '—'}`),
                  task.gitlabMR.pipeline === null || task.gitlabMR.pipeline === undefined ? null : h('div', { className: ART_REF },
                    h(ChipField, { variant: 'gray', 'data-sla': task.gitlabMR.pipeline.status === 'failed' ? 'overdue' : undefined }, `流水线 ${task.gitlabMR.pipeline.status}`),
                    ' ',
                    task.gitlabMR.pipeline.url === '' ? null : h('a', { className: LINK, href: task.gitlabMR.pipeline.url, target: '_blank', rel: 'noreferrer' }, `#${task.gitlabMR.pipeline.id}`),
                  ),
                ),
              )
            : h(TextField, { placeholder: '还没关联 MR；提了 MR 后会自动同步', value: draft.gitlabMR, onChange: e => setDraft({ ...draft, gitlabMR: e.target.value }) }),
        ),
      ),
      h('div', { className: ROW },
        h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void push((task.gitlabMR?.iid ?? 0) > 0 ? { ...draft, gitlabMR: undefined } : draft) }, '保存改动'),
        h(Button, { variant: 'danger', size: 'sm', disabled: busy, 'data-danger': '1', onClick: remove }, '只删卡'),
      ),
      ),
      h(Section, { pane: 'plan', current: pane, id: 'plan' },
        h(SectionHead, null, '计划',
          h('span', { className: HINT }, '这张卡属于哪个项目/迭代、谁提的、什么时候要')),
        h('div', { className: SECTION_BODY },
          h('div', { className: ROW },
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '业务项目'),
              h(SelectField, {
                value: plan.project,
                onChange: event => setPlan({ ...plan, project: event.target.value, iteration: '', service: '' }),
              },
                h('option', { value: '' }, '不属于任何项目'),
                (state.config?.projects ?? []).map(item => h('option', { key: item.id, value: item.id }, `${item.key ? `${item.key} · ` : ''}${item.name}`)),
              ),
            ),
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '迭代'),
              h(SelectField, {
                value: plan.iteration,
                onChange: event => setPlan({ ...plan, iteration: event.target.value }),
              },
                h('option', { value: '' }, '不指定迭代'),
                ((state.config?.projects ?? []).find(item => item.id === plan.project)?.iterations ?? [])
                  .map(item => h('option', { key: item.id, value: item.id }, item.name)),
              ),
            ),
          ),
          ((state.config?.projects ?? []).find(item => item.id === plan.project)?.services ?? []).length === 0
            ? null
            : h('div', { className: FIELD },
              h('div', { className: LABEL }, '服务（决定用哪个 git 路径切 worktree）'),
              h(SelectField, {
                value: plan.service ?? '',
                onChange: event => setPlan({ ...plan, service: event.target.value }),
              },
                h('option', { value: '' }, '用项目级默认目录'),
                ((state.config?.projects ?? []).find(item => item.id === plan.project)?.services ?? [])
                  .map(item => h('option', { key: item.id, value: item.id }, `${item.name}${item.repoPath ? ` · ${item.repoPath}` : ''}`)),
              ),
              h('div', { className: HINT }, '一个项目有多个服务（每个服务一个 git 路径）时，这里决定这张卡改哪个服务。'),
            ),
          h('div', { className: ROW },
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '类型'),
              h(SelectField, {
                'aria-label': '类型',
                value: plan.type,
                onChange: event => setPlan({ ...plan, type: event.target.value }),
              }, Object.keys(TYPE_LABEL).map(value => h('option', { key: value, value }, TYPE_LABEL[value]))),
            ),
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '优先级'),
              h(SelectField, {
                'aria-label': '优先级',
                value: plan.priority,
                onChange: event => setPlan({ ...plan, priority: event.target.value }),
              }, Object.keys(PRIORITY_LABEL).map(value => h('option', { key: value, value }, PRIORITY_LABEL[value]))),
            ),
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '父任务（缺陷挂到来源卡）'),
              h(SelectField, {
                'aria-label': '父任务',
                value: plan.parent ?? '',
                onChange: event => setPlan({ ...plan, parent: event.target.value }),
              },
                h('option', { value: '' }, '没有父任务'),
                (state.tasks ?? [])
                  .filter(item => item.id !== task.id && (plan.parent === item.id || !String(item.parent ?? '')))
                  .slice(0, 200)
                  .map(item => h('option', { key: item.id, value: item.id }, `${item.code || item.id} · ${String(item.title ?? '').slice(0, 30)}`)),
              ),
            ),
          ),
          h('div', { className: ROW },
            h('div', { className: FIELD, style: { flex: 2 } },
              h('div', { className: LABEL }, '业务负责人'),
              h(TextField, {
                value: plan.owner, placeholder: '提需求的人，例如 张伟',
                onChange: event => setPlan({ ...plan, owner: event.target.value }),
              }),
            ),
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '期望完成'),
              /* 以前是自由文本：随便打「下周」会被 fromDateInput 静默算成 0（等于没填）。
                 现在当场校验——打得不对就红字提示，不再悄悄丢掉。 */
              h(TextField, {
                value: plan.due,
                placeholder: 'YYYY-MM-DD，留空表示不设',
                'aria-label': '期望完成日期',
                'aria-invalid': plan.due.trim() !== '' && fromDateInput(plan.due) === 0 ? 'true' : undefined,
                onChange: event => setPlan({ ...plan, due: event.target.value }),
              }),
              plan.due.trim() !== '' && fromDateInput(plan.due) === 0
                ? h('div', { className: 'text-caption-1-regular text-text-error-primary', role: 'status', 'data-due-invalid': '' }, '日期看不懂，请用 YYYY-MM-DD（例：2026-12-01）')
                : null,
            ),
          ),
          h('div', { className: ROW },
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '所属版本'),
              h(SelectField, {
                value: plan.releaseId,
                onChange: event => setPlan({ ...plan, releaseId: event.target.value }),
              },
                h('option', { value: '' }, '不挂版本'),
                (state.releases ?? []).map(item => h('option', { key: item.id, value: item.id }, `${item.version || item.id} ${item.name}`.trim())),
              ),
            ),
            h('div', { className: FIELD, style: { flex: 1 } },
              h('div', { className: LABEL }, '编号'),
              h('div', { className: HINT }, task.code === '' ? '—（未挂需求）' : task.code),
            ),
          ),
          h('div', { className: ACTIONS },
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void savePlan() }, '保存计划'),
            task.dueAt > 0 && task.dueAt < Date.now() && task.status !== 'done'
              ? h('span', { className: ERR_TEXT }, '已逾期')
              : null,
          ),
        ),
      ),
      h(Section, { pane: 'plan', current: pane, id: 'worktree' },
        h(SectionHead, null, '代码隔离（git worktree）',
          h('span', { className: HINT }, worktree === null ? '这张卡还没有独立工作目录' : '这张卡自己的分支与目录')),
        h('div', { className: SECTION_BODY },
          worktree === null
            ? h('div', { className: FIELD },
              h('div', { className: HINT }, '开启「代码隔离 = worktree」并给项目配好本机代码目录后，派单会自动切一条 task/<编号> 分支；也可以先手动建一个。'),
              h('div', { className: ACTIONS },
                h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => void worktreeAction('create') }, '建 worktree'),
              ),
            )
            : h('div', { className: FIELD },
              h('div', { className: PANEL_LINE }, `${worktree.branch} · 基线 ${worktree.base}`),
              h('div', { className: PANEL_LINE }, worktree.path),
              h('div', { className: HINT }, `仓库 ${worktree.repo}${worktreeMsg ? ` · ${worktreeMsg}` : ''}`),
              h('div', { className: ACTIONS },
                h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => void worktreeAction('list') }, '看 git worktree 列表'),
                h(Button, { variant: 'danger', size: 'sm', disabled: busy, 'data-danger': '1', onClick: () => void worktreeAction('remove') }, '回收 worktree'),
              ),
            ),
          worktreeMsg && worktree === null ? h('div', { className: HINT }, worktreeMsg) : null,
        ),
      ),
      h(Section, { pane: 'handoff', current: pane, id: 'handoff', 'data-handoff': '' },
        h(SectionHead, null, '交接契约',
          h('span', { className: HINT }, '交给下一棒之前写清：决策 / 假设 / 未决 / 风险 / 影响面')),
        h('div', { className: SECTION_BODY },
          HANDOFF_FORM.map(([key, label, hint]) => h('div', { className: FIELD, key, 'data-handoff-field': key },
            h('div', { className: LABEL }, label),
            h(TextAreaField, {
              rows: 3, value: handoff[key],
              placeholder: hint,
              onChange: event => setHandoff({ ...handoff, [key]: event.target.value }),
            }),
          )),
          h('div', { className: HINT }, '派单提示词会先读这份契约，再看最近评论。清空全部字段保存 = 删除契约。'),
          h('div', { className: ACTIONS },
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveHandoff() }, '保存交接'),
            task.handoff !== null && task.handoff !== undefined
              ? h('span', { className: HINT }, `上次更新 ${fmtTime(task.handoff.at)}${task.handoff.by ? ` · ${task.handoff.by}` : ''}`)
              : h('span', { className: HINT }, '还没写过交接契约'),
          ),
        ),
      ),
      h(Section, { pane: 'design', current: pane, id: 'design' },
        h(SectionHead, null, '设计多稿与定案',
          h('span', { className: HINT }, `${DESIGN_LABEL[task.design?.status] ?? '未登记'}${chosenDraft === null ? '' : ` · 定案「${chosenDraft.name}」`}`)),
        h('div', { className: SECTION_BODY },
          designDrafts.length === 0
            ? h(EmptyState, { title: '还没有设计稿：加两稿以上才好比较' })
            : h('div', { className: 'flex min-w-0 flex-col gap-2' }, designDrafts.map(item => h('div', {
              key: item.id,
              'data-drawer-draft': item.id,
              className: 'flex min-w-0 items-start justify-between gap-4 rounded-xl border border-separator-border p-3'
                + (item.id === task.design?.chosenId ? ' border-separator-border-strong bg-background-secondary-default' : ''),
            },
              h('div', { className: GROW + ' flex flex-col gap-1' },
                h('div', null,
                  h(ChipField, { variant: 'gray', 'data-on': item.id === task.design?.chosenId ? '1' : '0' }, item.id === task.design?.chosenId ? '已定案' : '待选'),
                  h('span', { style: { marginLeft: 8 } }, item.name),
                ),
                item.link === '' ? null : h('a', { className: ART_REF, href: item.link, target: '_blank', rel: 'noreferrer' }, item.link),
                item.note === '' ? null : h('div', { className: HINT }, item.note),
              ),
              h('div', { className: ACTIONS },
                item.id === task.design?.chosenId
                  ? null
                  : h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void designAction('choose', item.id) }, '选为定案'),
                h(Button, { variant: 'danger', size: 'sm', disabled: busy, 'data-danger': '1', onClick: () => void designAction('remove', item.id) }, '删除'),
              ),
            ))),
          /* 评审意见就地可写：「要求修改」会把这里的内容一起提交（空的会被拦下）。 */
          h('div', { className: FIELD, style: { marginTop: 8 } },
            h('div', { className: LABEL }, '评审意见（驳回必填；写 @专家名 会叫起他）'),
            h(TextAreaField, {
              rows: 2,
              'aria-label': '设计评审意见',
              'data-design-note': '',
              value: designNote,
              placeholder: '例如：卡片密度太高，按「方案 A」改成两列；@开发工程师 改完再叫我',
              onChange: event => setDesignNote(event.target.value),
            }),
          ),
          h('div', { className: ROW, style: { gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => void addDesignDraft() }, '＋ 加一稿'),
            h(Button, { variant: 'primary', size: 'sm', disabled: busy || designDrafts.length === 0, onClick: () => void designAction('approve') }, '评审通过'),
            h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => void designAction('changes') }, '要求修改'),
            h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => void editDesignMetrics() }, '还原度/规范体检'),
          ),
          task.design?.note ? h('div', { className: HINT, style: { marginTop: 8 }, 'data-design-note-saved': '' }, `评审意见：${task.design.note}`) : null,
          task.design?.diff == null ? null : h('div', { className: HINT, style: { marginTop: 8 } }, `还原度差异 ${task.design.diff.percent}%（越高越不还原）`),
          task.design?.spec == null ? null : h('div', { className: HINT, style: { marginTop: 8 } }, `规范体检：查了 ${task.design.spec.checked} 个元素，${task.design.spec.violations} 处野值`),
        ),
      ),
      renderCodingSection(),
      renderDiffSection(),
      renderMergeGateSection(),
      renderQualitySection(),
      renderFeedSection(),
      renderSkillSection(),
        ),
        h('div', { className: 'flex min-w-0 flex-col gap-4' },
      h(Section, { pane: 'test', current: pane, id: 'checklist' },
        h(SectionHead, null, '验收清单',
          h('span', { className: HINT }, checkSum.total === 0 ? '这张卡还没有清单' : `${doneCount} / ${checkSum.total} 已勾`)),
        h('div', { className: SECTION_BODY },
          checkSum.total === 0 ? null : h('div', { className: 'mb-1', 'data-drawer-checklist': '', 'data-full': doneCount === checkSum.total ? '1' : '0' },
            h(ProgressTrack, { percentage: checkSum.total === 0 ? 0 : Math.round(doneCount / checkSum.total * 100), size: 'sm' }),
          ),
          parts === null && checkSum.total > 0 ? h('div', { className: HINT }, '载入清单…') : checklist.map(item => h('div', {
            key: item.id,
            'data-done': item.done ? '1' : '0',
            'data-drawer-check-row': item.id,
            className: 'flex min-w-0 items-start gap-2 border-b border-separator-border py-2 last:border-b-0',
          },
            h(CheckField, { checked: item.done, disabled: busy, title: item.text,
              onChange: () => void toggleChecklist(item),
            }),
            h('div', { className: GROW },
              h('div', { className: 'text-body-2-regular ' + (item.done ? 'text-text-tertiary line-through' : 'text-text-primary') }, item.text, h('span', { className: HINT }, ` #${item.id}`)),
              item.note || item.by
                ? h('div', { className: HINT }, `${item.by ? `${item.by} · ` : ''}${item.at ? fmtTime(item.at) : ''}${item.note ? ` · ${item.note}` : ''}`)
                : null,
            ),
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy, 'aria-label': '删除这条验收条目', onClick: () => void removeChecklist(item) }, '×'),
          )),
          h('div', { className: ROW },
            h(TextField, {
              style: { flex: 1 }, value: newItem, placeholder: '再加一条验收条目，回车提交',
              onChange: event => setNewItem(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter') void addChecklist() },
            }),
            h(Button, { variant: 'secondary', size: 'sm', disabled: busy || newItem.trim() === '', onClick: () => void addChecklist() }, '＋ 加一条'),
          ),
          h('div', { className: HINT }, '清单就是「做完」的定义：AI 每完成一项要勾一项并附证据；人也可以直接勾。'),
        ),
      ),
      h(Section, { pane: 'deliver', current: pane, id: 'artifacts' },
        h(SectionHead, null, '交付物',
          h('span', { className: HINT }, '文档、MR、用例、报告——交付要有东西，不只是一句「做完了」；登记后按设置的文档出口归档（飞书云盘 / WeKnora）'),
          artifactsWithoutBody(task).length > 0
            ? h('span', { className: WARN_TEXT, title: '这些交付物还没写正文，点「正文」补上再同步' }, statusDot(h, 'warn'), ` ${artifactsWithoutBody(task).length} 件缺正文`)
            : null,
          (task.artifacts ?? []).length > 0
            ? h(Button, {
              variant: 'ghost', size: 'sm', disabled: busy,
              title: '把这张卡的交付物全部写进需求文件夹（已归档的会覆盖更新）',
              onClick: () => void syncAllArtifacts(),
            }, '同步到云盘')
            : null),
        h('div', { className: SECTION_BODY, 'data-scroll': '1' },
          artifacts.length === 0
            ? h(EmptyState, { title: '还没有交付物。', hint: '文档、MR、用例、报告——交付要有东西，不只是一句「做完了」。' })
            : h(React.Fragment, null,
              artifacts.length > 5 || artifactQuery !== ''
                ? h('div', { className: ROW, 'data-artifact-filter': '' },
                  h('div', { className: 'w-64 max-w-full' },
                    h(TextField, { value: artifactQuery, placeholder: '按标题 / 类型 / 链接筛…', 'aria-label': '筛交付物', onChange: event => setArtifactQuery(event.target.value) })),
                  h('span', { className: HINT }, `显示 ${visibleArtifacts.length} / ${artifacts.length}`),
                  artifactQuery === '' ? null : h(Button, { variant: 'ghost', size: 'xs', onClick: () => setArtifactQuery('') }, '清除'))
                : null,
              visibleArtifacts.length === 0
                ? h('div', { className: HINT }, '没有匹配的交付物')
                : visibleArtifacts.map(item => h('div', { key: item.id, className: 'flex min-w-0 flex-col gap-2', 'data-drawer-artifact': item.id }, h('div', {
              className: LIST_ROW + (artifactHasBody(item) ? '' : ' bg-background-tertiary-error'),
              'data-missing': artifactHasBody(item) ? '0' : '1',
            },
              h(ChipField, { variant: 'gray', 'data-kind': item.kind }, ARTIFACT_KIND_LABEL[item.kind] ?? item.kind),
              h('div', { className: GROW },
                h('div', { className: ART_TITLE },
                  artifactHasBody(item)
                    ? null
                    : h('span', { className: WARN_TEXT, title: '这条交付物还没写正文，云盘文档里只有标题' }, statusDot(h, 'warn', { style: { marginRight: 8 } })),
                  item.title,
                ),
                h('div', { className: ART_REF }, `正文 ${typeof item.contentLength === 'number' ? item.contentLength : String(item.content ?? '').length} 字${artifactHasBody(item) ? '' : ' · 缺正文'}${item.doc?.url ? '' : ' · 还没归档'}`),
                item.ref === '' ? null : h('div', { className: ART_REF }, item.ref),
                item.doc?.url
                  ? h('a', { className: ART_REF, href: item.doc.url, target: '_blank', rel: 'noreferrer' }, uiIcon(h, 'file'), ` ${item.doc.name || '云盘文档'}`)
                  : (item.doc?.error ? h('div', { className: ERR_TEXT }, item.doc.error) : null),
              ),
              /\.(png|jpe?g|webp|gif)$/i.test(String(item.ref ?? ''))
                ? h(Button, {
                  variant: 'ghost', size: 'sm', disabled: busy, title: '看这张截图（只读，来自白名单目录）',
                  onClick: () => void previewArtifact(item),
                }, imageOf === item.id ? '收起图' : '看图')
                : null,
              h(Button, {
                variant: 'ghost', size: 'sm', disabled: busy, title: '直接读正文（Markdown 渲染）',
                onClick: () => void readArtifact(item),
              }, artRead === item.id ? '收起' : '阅读'),
              imageOf !== item.id ? null : h('div', {
                className: 'fixed inset-0 z-[70] flex cursor-zoom-out items-center justify-center bg-black/55',
                'data-drawer-image': '',
                onClick: () => setImageOf(''),
                style: { top: 'max(env(titlebar-area-height, 0px), var(--ds-titlebar-floor, 0px))', WebkitAppRegion: 'no-drag' },
              },
                imageError !== null
                  ? h('div', { className: ERR_TEXT + ' rounded-xl bg-background-primary-default p-3' }, imageError)
                  : (imageData === null
                    ? h('div', { className: HINT + ' rounded-xl bg-background-primary-default p-3' }, '正在读这张图…')
                    : h('img', {
                      src: imageData, alt: item.title,
                      onClick: event => event.stopPropagation(),
                      className: 'rounded-xl border border-separator-border bg-background-primary-default shadow-2xl',
                      style: { maxWidth: '92vw', maxHeight: '86vh' },
                    }))),
              h(Button, {
                variant: 'ghost', size: 'sm', disabled: busy, title: '编辑正文',
                onClick: () => void editArtifact(item),
              }, '正文'),
              item.doc?.url
                ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: '用最新正文覆盖云盘文档', onClick: () => void syncArtifactTo(item) }, '更新')
                : h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: '写进需求文件夹', onClick: () => void syncArtifactTo(item) }, '归档'),
              h(SelectField, {
                style: { width: 92, height: 22, fontSize: 11 }, value: item.status, disabled: busy,
                onChange: event => void setArtifactStatus(item, event.target.value),
              }, ARTIFACT_STATUS.map(value => h('option', { key: value, value }, ARTIFACT_STATUS_LABEL[value]))),
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy, 'aria-label': '删除这条交付物', onClick: () => void removeArtifact(item) }, '×'),
            ),
            artRead === item.id
              ? h('div', { className: 'md-content overflow-auto rounded-xl border border-separator-border bg-background-primary-default px-3 py-2', style: { maxHeight: 360 } }, artBodies[item.id] === undefined && artifactHasBody(item)
                ? h('span', { className: HINT }, '读取中…')
                : artifactBody(item).trim() === ''
                  ? h('span', { className: HINT }, '这条交付物还没有正文。')
                  : renderMarkdown(artifactBody(item)))
              : null,
          ))),
          artEdit === null ? null : h('div', { style: { marginTop: 8 } },
            h(MdField, {
              style: { width: '100%' }, rows: 8, value: artEdit.content,
              placeholder: '写清楚做了什么、结论、风险。这段会原样写进云盘文档正文。',
              onChange: event => setArtEdit({ ...artEdit, content: event.target.value }),
            }),
            h('div', { className: ROW, style: { justifyContent: 'flex-end', marginTop: 8 } },
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setArtEdit(null) }, '取消'),
              h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => void saveArtifactContent({ id: artEdit.id }) }, '保存正文并同步'),
            ),
          ),
          h('div', { className: ROW },
            h(SelectField, {
              style: { width: 104 }, value: artifact.kind,
              onChange: event => setArtifact({ ...artifact, kind: event.target.value }),
            }, ARTIFACT_KINDS.map(value => h('option', { key: value, value }, ARTIFACT_KIND_LABEL[value]))),
            h(TextField, {
              style: { flex: 1 }, value: artifact.title, placeholder: '交付物名称，例如 登录模块技术方案',
              onChange: event => setArtifact({ ...artifact, title: event.target.value }),
            }),
            h(TextField, {
              style: { flex: 1 }, value: artifact.ref, placeholder: '路径 / 链接 / MR 号',
              onChange: event => setArtifact({ ...artifact, ref: event.target.value }),
            }),
          ),
          h(MdField, {
            style: { width: '100%', marginTop: 8 }, rows: 5, value: artifact.content,
            placeholder: '交付物正文（Markdown）。这段会原样写成云盘文档的正文：做什么、怎么做、结论、风险。留空也能登记，但云盘里只有标题。',
            onChange: event => setArtifact({ ...artifact, content: event.target.value }),
          }),
          h('div', { className: ROW, style: { justifyContent: 'flex-end', marginTop: 8 } },
            h(Button, {
              variant: 'secondary', size: 'sm', disabled: busy || artifact.title.trim() === '',
              onClick: () => void addArtifact(),
            }, '登记并归档'),
          ),
        ),
      ),
      h(Section, { pane: 'test', current: pane, id: 'cases' },
        h(SectionHead, null, '测试用例',
          h('span', { className: HINT }, caseSum.total === 0
            ? '测试同学把用例登记在这里，逐条执行并回填结果'
            : `${caseSummary}${staleCases > 0 ? ` · 需复跑 ${staleCases}` : ''}`),
          h(Button, {
            variant: 'ghost', size: 'sm',
            disabled: caseGen.busy,
            title: '按功能点 / 验收条件生成「标题草稿」：规则推断不出可执行断言，草稿不计入覆盖率。'
              + '要能真的跑，请用测试专家 / studio_task_add_cases 补 method+path 或 command。',
            onClick: () => void generateCases(),
          }, caseGen.busy ? '生成中…' : '生成用例草稿'),
          h(Button, {
            variant: 'primary', size: 'sm',
            disabled: caseRun.busy || cases.filter(item => item.http != null || item.shell != null || item.db != null || item.browser != null).length === 0,
            onClick: () => void runCases(undefined),
          }, caseRun.busy ? '运行中…' : [uiIcon(h, 'run'), ' 跑用例'])),
        h('div', { className: SECTION_BODY, 'data-scroll': '1' },
          caseEditBlock(),
          caseRun.busy ? h('div', { className: 'sticky top-0 z-10 rounded-lg bg-background-primary-default px-2 py-1 text-caption-1-regular text-text-secondary', 'data-case-running': '' }, '正在跑用例…') : null,
          caseRun.note === '' ? null : h('div', { className: HINT, style: { position: 'sticky', top: 0, zIndex: 5, background: 'inherit' }, 'data-run-note': '' }, caseRun.note),
          h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2', 'data-case-filter': '' },
            ...[['all', '全部', caseSum.total], ['pending', '未跑', casePending], ['fail', '不通过', caseFail], ['skip', '跳过', caseSkip], ['pass', '通过', casePass]]
              .map(([id, label, count]) => h(ChipField, {
                key: id, variant: caseFilter === id ? 'soft' : 'gray', className: 'cursor-pointer',
                'data-case-filter-chip': id,
                role: 'button', tabIndex: 0, 'aria-pressed': caseFilter === id,
                'aria-label': `筛选用例：${label}`,
                onClick: () => setCaseFilter(id),
                onKeyDown: event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setCaseFilter(id) }
                },
              }, `${label} ${count}`)),
            h('div', { className: 'w-56 max-w-full' },
              h(TextField, {
                value: caseQuery, placeholder: '筛标题 / 期望 / 记录', 'aria-label': '筛用例',
                onChange: event => setCaseQuery(event.target.value),
              })),
            caseFilter === 'all' && caseQuery === '' ? null : h(Button, { variant: 'ghost', size: 'sm', onClick: () => { setCaseFilter('all'); setCaseQuery('') } }, '清除筛选'),
          ),
          caseGen.note === '' ? null : h('div', { className: HINT }, caseGen.note),
          caseSum.total === 0
            ? h(EmptyState, { title: '还没有用例。', hint: '测试同学把用例登记在这里，逐条执行并回填结果。' })
            : parts === null
              ? h('div', { className: HINT }, '载入用例…')
              : visibleCases.length === 0
                ? h('div', { className: HINT }, '没有匹配的用例。')
                : visibleCases.map(item => h('div', {
                key: item.id,
                'data-result': item.result,
                'data-drawer-case-row': item.id,
                /* 每条用例一张小卡片：结果选择在左、标题与操作在顶部、明细在下面。
                   以前是 items-center 的列表行，操作按钮垂直居中在一堆长文本中间，看着很乱。 */
                className: 'flex min-w-0 items-start gap-3 rounded-lg border border-separator-border border-l-4 bg-background-primary-default px-3 py-3 ' + (CASE_RESULT_RAIL[item.result] ?? ''),
              },
              h(SelectField, {
                size: 'sm', style: { width: 88 }, value: item.result, disabled: busy,
                'aria-label': `用例结果：${item.title}`,
                onChange: event => void setCaseResult(item, event.target.value),
              }, CASE_RESULTS.map(value => h('option', { key: value, value }, CASE_RESULT_LABEL[value]))),
              h('div', { className: GROW },
                h('div', { className: 'line-clamp-2 text-body-2-semibold text-text-primary', title: item.title }, item.title),
                h('div', { className: ROW, style: { gap: 8, alignItems: 'center', marginTop: 2 } },
                  h(ChipField, { variant: CASE_RESULT_CHIP[item.result] ?? 'neutral', 'data-case-result': item.result }, CASE_RESULT_LABEL[item.result] ?? item.result),
                  h(ChipField, { variant: 'soft' }, CASE_TYPE_LABEL[item.type ?? 'functional'] ?? '功能'),
                  h(SelectField, {
                    size: 'sm', style: { width: 108 },
                    value: item.tier ?? '',
                    disabled: busy,
                    title: `${CASE_TIER_HINT[item.tierEffective ?? 'other'] ?? ''}（当前按${item.tier === '' || item.tier === undefined ? '断言推断' : '手动指定'}：${CASE_TIER_FULL[item.tierEffective ?? 'other'] ?? '其它'}）`,
                    'data-case-tier-select': item.id,
                    onChange: event => void setCaseTier(item, event.target.value),
                  },
                    h('option', { value: '' }, `自动·${CASE_TIER_LABEL[item.tierEffective ?? 'other'] ?? '其它'}`),
                    CASE_TIERS.map(value => h('option', { key: value, value }, CASE_TIER_LABEL[value])),
                  ),
                  h(ChipField, { variant: 'soft', 'data-pri': item.priority ?? 'p2' }, String(item.priority ?? 'p2').toUpperCase()),
                  item.stale === true
                    ? h(ChipField, { variant: 'yellow', 'data-stale': '1', title: '需求文档更新后还没复跑：这条结果可能是旧口径' }, '需复跑')
                    : null,
                  caseBugMap[item.id] !== undefined
                    ? h(ChipField, { variant: 'rose', 'data-case-bug': caseBugMap[item.id], title: '这条用例失败后自动开的缺陷' }, '缺陷 ' + caseBugMap[item.id])
                    : null,
                  String(item.preconditions ?? '') === '' ? null : h('span', { className: HINT }, `前置：${item.preconditions}`),
                  (item.steps ?? []).length === 0 ? null : h('span', { className: HINT }, `步骤 ${item.steps.length} 条`),
                ),
                item.expected === '' ? null : h('div', { className: 'md-content min-w-0 text-caption-1-regular text-text-secondary', 'data-case-expected': '' },
                  h('span', { className: HINT }, '期望：'),
                  renderMarkdown(item.expected)),
              expandedCaseIds.has(item.id) === true ? h('div', { className: 'flex min-w-0 flex-col gap-1', 'data-case-details': '' },
              // 四种可执行用例各显示自己的定义。以前这里是一个三元链，db 那条永远走不到。
              (() => {
                if (item.browser != null) {
                  return h('div', { className: ART_REF }, `浏览器：${item.browser.url}`
                    + (item.browser.expectText ? ` → 含 «${item.browser.expectText}»` : '')
                    + (item.browser.expectSelector ? ` → 存在 ${item.browser.expectSelector}` : '')
                    + ((item.browser.steps ?? []).length > 0 ? ` · ${item.browser.steps.length} 步` : ''))
                }
                if (item.shell != null) return h('div', { className: ART_REF }, 'shell：' + item.shell.command)
                if (item.db != null) return h('div', { className: ART_REF }, 'db：' + item.db.sql)
                if (item.http != null) return h('div', { className: ART_REF }, `接口：${item.http.method} ${item.http.url} → 期望 ${item.http.expectStatus}${item.http.expectContains ? ` 且含 «${item.http.expectContains}»` : ''}`)
                return null
              })(),
                item.lastRun == null ? null : h('div', { className: ART_REF }, `${item.lastRun.ok ? '通过' : '不通过'} 最近执行：${item.lastRun.status === 0 ? item.lastRun.error : `${item.lastRun.status} · ${item.lastRun.ms}ms`}（${fmtTime(item.lastRun.at)}）`),
                item.lastRun?.response ? h('div', { className: NOTE_BOX }, `响应片段：${String(item.lastRun.response).slice(0, 400)}${String(item.lastRun.response).length > 400 ? '…' : ''}`) : null,
                (item.lastRun?.steps ?? []).length === 0 ? null : h('div', { className: ART_REF }, `步骤：${item.lastRun.steps.map(step => `${step.ok ? '' : '失败 · '}${step.method} ${step.url}${step.status === 0 ? '' : ` → ${step.status}`}`).join('；')}`),
                (item.http?.steps ?? []).length === 0 ? null : h(ChipField, { variant: 'soft' }, `多步 ${item.http.steps.length}`),
                ((state.requirements ?? []).find(entry => entry.id === task.requirementId)?.points ?? []).length === 0
                  ? (item.pointId ? h('div', { className: ART_REF }, `功能点：${item.pointId}`) : null)
                  : h('div', { className: ROW, style: { gap: 8, alignItems: 'center' } },
                      h('span', { className: HINT }, '功能点'),
                      h(SelectField, {
                        style: { width: 190, height: 26 },
                        value: item.pointId ?? '',
                        onChange: async event => {
                          try {
                            await api('/task/case', { id: task.id, action: 'update', caseId: item.id, pointId: event.target.value })
                            await onChanged()
                          } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
                        },
                      },
                        h('option', { value: '' }, '不归功能点'),
                        ((state.requirements ?? []).find(entry => entry.id === task.requirementId)?.points ?? []).map(point => h('option', { key: point.id, value: point.id }, `${point.id} ${point.title}`)),
                      ),
                    ),
                item.note === '' ? null : h('div', { className: 'md-content min-w-0 text-caption-1-regular text-text-secondary', 'data-case-note': '' },
                  h('span', { className: HINT }, '记录：'),
                  renderMarkdown(item.note),
                  item.by ? h('span', { className: HINT }, ` — ${item.by}`) : null),
                h('div', { className: 'flex justify-end gap-2' },
                  h(Button, {
                    variant: 'ghost', size: 'sm', disabled: busy,
                    title: '标记为不稳定用例：失败时不自动开缺陷',
                    'data-flaky': item.flaky === true ? '1' : '0',
                    onClick: () => void toggleFlaky(item),
                  }, item.flaky === true ? '恢复稳定' : '标记不稳定'),
                  h(Button, { variant: 'danger', size: 'sm', disabled: busy, title: '删除这条用例（先确认）', 'aria-label': '删除这条用例', onClick: () => void removeCase(item) }, '删除这条用例')),
              ) : null,
              ),
              h('div', { className: 'flex shrink-0 items-start gap-1' },
              h(Button, {
                variant: 'ghost', size: 'sm',
                'data-case-expand': item.id,
                'aria-expanded': expandedCaseIds.has(item.id),
                title: '展开/收起这条用例的接口定义、响应、步骤与功能点',
                onClick: () => setExpandedCaseIds(previous => {
                  const next = new Set(previous)
                  if (next.has(item.id)) next.delete(item.id)
                  else next.add(item.id)
                  return next
                }),
              }, expandedCaseIds.has(item.id) ? '收起' : '详情'),
              (item.http == null && item.shell == null && item.db == null && item.browser == null)
                ? null
                : h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: '改这条用例的定义（地址 / 命令 / SQL / 断言）；lastRun 与历史保留', onClick: () => void editCaseDefinition(item) }, '改定义'),
              (item.http == null && item.shell == null && item.db == null && item.browser == null)
                ? null
                : h(Button, { variant: 'ghost', size: 'sm', disabled: caseRun.busy, title: '跑这条用例', 'aria-label': '跑这条用例', onClick: () => void runCases(item.id) }, uiIcon(h, 'run')),
              ))),

          h('div', { className: ROW },
            h(TextField, {
              style: { flex: 1 }, value: newCase.title, placeholder: '用例：做什么，例如 用错误密码连续登录 5 次',
              onChange: event => setNewCase({ ...newCase, title: event.target.value }),
            }),
            h(TextField, {
              style: { flex: 1 }, value: newCase.expected, placeholder: '期望结果，例如 第 5 次返回 429 并锁定 10 分钟',
              onChange: event => setNewCase({ ...newCase, expected: event.target.value }),
            }),
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: '加一条单元测试用例：跑仓库里的单测命令，断言退出码与输出（需要先在设置里打开 allowShell）', onClick: () => void addShellCase('unit') }, '＋ 单元'),
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: '加一条 shell 用例：跑命令看退出码与输出（需要先在设置里打开 allowShell）', onClick: () => void addShellCase() }, '＋ shell'),
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: '加一条数据库用例：查库断言行数与某列值（需要先在设置里打开 allowDb）', onClick: () => void addDbCase() }, '＋ 数据库'),
            h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: '加一条浏览器用例：真开 Chrome/Edge 打开页面，断言看得见的东西（需要先在设置里打开 allowBrowser）', onClick: () => void addBrowserCase() }, '＋ 浏览器'),
            h(Button, { variant: 'secondary', size: 'sm', disabled: busy || newCase.title.trim() === '', onClick: () => void addCase() }, '＋ 加用例'),
          ),
          (() => {
            const points = (state.requirements ?? []).find(entry => entry.id === task.requirementId)?.points ?? []
            if (points.length === 0) return null
            return h('div', { className: ROW, style: { gap: 8, alignItems: 'center', marginTop: 8 }, 'data-case-point-row': '' },
              h('span', { className: HINT }, '这条用例算在'),
              h(SelectField, {
                style: { width: 240, height: 28 }, value: newCase.pointId ?? '',
                onChange: event => setNewCase({ ...newCase, pointId: event.target.value }),
              },
                h('option', { value: '' }, '不归功能点'),
                points.map(point => h('option', { key: point.id, value: point.id }, point.id + '｜' + point.title)),
              ),
              h('span', { className: HINT }, '默认跟卡上的功能点；改这里只影响新加的这条'),
            )
          })(),
          h('div', { className: ROW, style: { gap: 8, flexWrap: 'wrap', marginTop: 8 } },
            h(SelectField, {
              style: { width: 96 }, value: newCase.type ?? 'functional',
              onChange: event => setNewCase({ ...newCase, type: event.target.value }),
            }, CASE_TYPES.map(value => h('option', { key: value, value }, CASE_TYPE_LABEL[value]))),
            h(SelectField, {
              style: { width: 84 }, value: newCase.priority ?? 'p2',
              onChange: event => setNewCase({ ...newCase, priority: event.target.value }),
            }, CASE_PRIORITIES.map(value => h('option', { key: value, value }, value.toUpperCase()))),
            h(SelectField, {
              style: { width: 104 }, value: newCase.tier ?? '', title: '测试层级：自动 = 按断言推断（接口/数据库 → 集成，浏览器 → 端到端，单测命令 → 单元）',
              onChange: event => setNewCase({ ...newCase, tier: event.target.value }),
            },
              h('option', { value: '' }, '层级·自动'),
              CASE_TIERS.map(value => h('option', { key: value, value }, CASE_TIER_FULL[value])),
            ),
            h(TextField, {
              style: { flex: 1, minWidth: 200 }, value: newCase.preconditions ?? '', placeholder: '前置条件，例如 会员等级≥银卡、账户余额充足',
              onChange: event => setNewCase({ ...newCase, preconditions: event.target.value }),
            }),
          ),
          h('div', { className: FIELD },
            h('label', {}, '测试步骤（可选，一行一步）'),
            h(TextAreaField, {
              rows: 2, value: newCase.stepsText ?? '',
              placeholder: '1. 打开积分抵扣页\n2. 选择「抵扣 10 元」\n3. 提交订单',
              onChange: event => setNewCase({ ...newCase, stepsText: event.target.value }),
            }),
          ),
          h('div', { className: FIELD },
            h('label', {}, '多步接口（可选，一行一步：METHOD url | 期望状态码 | 提取变量）'),
            h(TextAreaField, {
              rows: 3, value: newCase.steps,
              placeholder: 'POST /api/auth/login | 200 | data.token\nGET /api/points | 200 |',
              onChange: event => setNewCase({ ...newCase, steps: event.target.value }),
            }),
            h('div', { className: HINT }, '先登录取 token、再带 token 调业务接口时用；变量写成 {{data.token}} 放进 url 或 body。第一步失败后面不会跑。'),
          ),
          testPlanBlock(),
        ),
      ),
      h(Section, { pane: 'overview', current: pane, id: 'meta' },
        h(SectionHead, null, '其它信息'),
      h('dl', {
        className: 'grid gap-x-3 gap-y-2 rounded-xl border border-separator-border bg-background-secondary-default p-3 text-caption-1-regular [&>dt]:text-text-tertiary [&>dd]:m-0 [&>dd]:break-all [&>dd]:text-text-primary',
        style: { gridTemplateColumns: '92px 1fr' },
        'data-drawer-kv': '',
      },
        h('dt', {}, '编号'), h('dd', {}, task.code === undefined || task.code === '' ? '未挂需求（无编号）' : task.code),
        h('dt', {}, '所属需求'), h('dd', {}, (() => {
          const req = (state.requirements ?? []).find(item => item.id === task.requirementId)
          return req === undefined ? '未挂需求' : `${req.code || req.id}｜${req.title}`
        })()),
        h('dt', {}, '所属项目'), h('dd', {}, (state.config?.projects ?? []).find(item => item.id === task.project)?.name ?? '未归属项目'),
        h('dt', {}, '迭代'), h('dd', {}, ((state.config?.projects ?? []).find(item => item.id === task.project)?.iterations ?? []).find(item => item.id === task.iteration)?.name ?? '未排期'),
        h('dt', {}, '服务'), h('dd', {}, (() => {
          const project = (state.config?.projects ?? []).find(item => item.id === task.project)
          if ((task.service ?? '') === '') return '未指定（用项目默认目录）'
          const service = (project?.services ?? []).find(item => item.id === task.service)
          if (service === undefined) return `${task.service}（已失效）`
          const deps = (service.dependsOn ?? [])
            .map(id => (project.services ?? []).find(one => one.id === id))
            .filter(one => one !== undefined)
          const depNote = deps.length === 0 ? '' : ` · 依赖 ${deps.map(one => one.name).join('、')}`
          return `${service.name}${service.repoPath ? ` · ${service.repoPath}` : ''}${depNote}`
        })()),
        h('dt', {}, '父任务'), h('dd', {}, (() => {
          if (task.parent === '' || task.parent === undefined) return '无'
          const parent = (state.tasks ?? []).find(item => item.id === task.parent)
          return parent === undefined ? task.parent : `${parent.code || parent.id}｜${parent.title}`
        })()),
        h('dt', {}, '来源用例'), h('dd', {}, task.bugSource == null
          ? '无（不是用例自动开的缺陷）'
          : `${task.bugSource.code || task.bugSource.taskId} · ${task.bugSource.caseTitle}（判失败于 ${fmtTime(task.bugSource.at)}，${task.bugSource.by || '系统'}）`),
        h('dt', {}, '关联缺陷'), h('dd', {}, (() => {
          const bugs = (state.tasks ?? []).filter(item => item.bugSource != null && item.bugSource.taskId === task.id)
          return bugs.length === 0
            ? '无'
            : bugs.map(item => `${item.code || item.id}（${(state.statuses ?? []).find(entry => entry.id === item.status)?.label ?? item.status}）`).join('、')
        })()),
        h('dt', {}, '飞书会话'), h('dd', {}, task.feishuThread === '' || task.feishuThread === undefined ? '未关联' : task.feishuThread),
      ),
      (() => {
        /* /state 每轮只带最近 12 条（全量时 75 张卡的 /state 是 1.34 MB，其中 383 KB 是历史里的长备注），
           这里按需补全文：点「加载全部」走 /task/parts。展示顺序与判据不变。 */
        const trimmed = Array.isArray(task.history) ? task.history : []
        const full = historyAll === null ? trimmed : historyAll
        const history = [...full].reverse()
        const total = Number(task.historyTotal ?? trimmed.length)
        if (history.length === 0) return h('div', { className: 'mt-3 ' + HINT, 'data-status-history': '' }, '状态历史：无')
        const row = (item, index) => {
          const label = (state.statuses ?? []).find(entry => entry.id === item.status)?.label ?? String(item.status ?? '')
          return h('li', {
            key: String(item.at ?? 0) + '-' + index,
            className: 'flex min-w-0 items-start gap-2 border-b border-separator-border pb-2 last:border-b-0 last:pb-0',
            'data-history-row': '',
          },
            h('span', { className: 'w-[86px] shrink-0 text-caption-1-regular text-text-tertiary tabular-nums' }, fmtTime(item.at)),
            h('div', { className: 'flex min-w-0 flex-1 flex-col gap-0.5' },
              h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2' },
                h(ChipField, { variant: 'soft' }, label),
                item.by ? h('span', { className: HINT }, String(item.by)) : null),
              (item.note === undefined || item.note === '') ? null : h('div', { className: 'break-words text-caption-1-regular text-text-secondary' }, String(item.note)),
            ),
          )
        }
        const recent = history.slice(0, 5)
        const rest = history.slice(5)
        return h('div', { className: 'mt-3 flex min-w-0 flex-col gap-2', 'data-status-history': '' },
          h('div', { className: 'flex min-w-0 flex-wrap items-center justify-between gap-2' },
            h('div', { className: 'text-caption-2-medium text-text-secondary' }, `状态历史（${total}）`),
            total > trimmed.length && historyAll === null
              ? h(Button, { variant: 'ghost', size: 'xs', 'data-history-load-all': '', disabled: historyBusy, onClick: loadFullHistory }, historyBusy ? '加载中…' : `加载全部 ${total} 条`)
              : null,
            h('span', { className: HINT }, '最新的在最上面')),
          h('ol', { className: 'flex min-w-0 flex-col gap-2' }, recent.map(row)),
          rest.length === 0 ? null : h('details', { className: 'rounded-lg border border-separator-border px-3 py-2', 'data-history-rest': '' },
            h('summary', { className: 'cursor-pointer text-caption-1-regular text-text-secondary' }, `展开其余 ${rest.length} 条`),
            h('ol', { className: 'mt-2 flex min-w-0 flex-col gap-2' }, rest.map(row))),
        )
      })(),
      ),
      h(Section, { pane: 'discuss', current: pane, id: 'comments' },
        h(SectionHead, null, `评论（${commentTotal}）`, h('span', { className: HINT }, '最新的在最上面')),
        commentTotal === 0
          ? h(EmptyState, { title: '还没有评论。', hint: '在下面输入，或用 @专家名 直接点名派活。' })
          : commentList === null
            ? h('div', { className: HINT, style: { padding: '8px 2px' } }, '载入评论…')
            : h('div', { className: 'flex min-w-0 flex-col gap-2', 'data-drawer-comments': '' },
            commentList.slice().reverse().map(item => {
              const experts = state.config?.experts ?? []
              const expert = experts.find(entry => entry.name === item.author)
                ?? experts.find(entry => item.author !== undefined && item.author !== ''
                  && (entry.name.includes(item.author) || item.author.includes(entry.name)))
                ?? experts.find(entry => item.author === (ROLE_LABEL[entry.role] ?? ''))
              // 没写 kind 的历史评论：作者对不上任何专家、也不像角色名，就按「人」处理，
              // 避免人也画出机器人头像。
              const looksAi = /产品|架构|研发|开发|测试|运维|专家/.test(String(item.author ?? ''))
              const human = item.kind === 'human' ? true : item.kind === 'agent' ? false : !(expert !== undefined || looksAi)
              /* 登录后作者记的是登录名：只有它等于当前登录人才显示「我」，
                 否则同事的评论会被误认成自己（以前作者一律写死「人」，所有人都看到「我提出」）。 */
              const me = currentUser()
              const mine = human && (item.author === undefined || item.author === '' || item.author === me)
              const who = human
                ? (mine ? '我' : item.author)
                : (expert?.name ?? (item.author === '' || item.author === undefined ? 'AI' : item.author))
              // 老评论的作者可能是「架构」「研发」这类简写，或带 emoji 前缀；
              // 能对上专家就统一显示专家本名，对不上原样显示。
              const bodyNodes = renderMarkdown(item.body)
              const roleRail = COMMENT_ROLE_RAIL[expert?.role] ?? 'border-l-separator-border'
              return h('div', {
                key: item.id,
                'data-kind': human ? 'human' : 'agent',
                'data-role': expert?.role ?? '',
                'data-drawer-comment': item.id,
                className: 'grid min-w-0 items-start gap-3 border-t border-separator-border pt-2 first:border-t-0 first:pt-0'
                  + (human ? '' : ' ml-6'),
                style: { gridTemplateColumns: '32px minmax(0,1fr)' },
              },
                h('div', {
                  className: 'flex size-8 items-center justify-center rounded-full border '
                    + (human ? 'border-transparent bg-accent-600 text-text-white' : 'border-separator-border bg-background-secondary-default text-text-secondary'),
                },
                  human ? h('span', { className: 'text-caption-1-semibold' }, who.slice(0, 1)) : h('span', { className: 'flex items-center justify-center' }, uiIcon(h, expertIconName(expert)))),
                h('div', { className: 'flex min-w-0 flex-col gap-1' },
                  h('div', { className: 'flex min-w-0 flex-wrap items-center gap-2' },
                    h('span', { className: 'text-body-2-semibold text-text-primary' }, who),
                    h('span', { className: 'rounded-full border border-separator-border px-2 text-caption-1-regular text-text-tertiary' }, human ? (mine ? '我提出' : '人提出') : 'AI 回复'),
                    expert !== undefined && expert.domain !== '' ? h(ChipField, { variant: 'gray', 'data-role': expert.role }, expert.domain) : null,
                    h('div', { className: 'ml-auto flex items-center gap-1' },
                      h('span', { className: 'text-caption-1-regular text-text-tertiary tabular-nums' }, fmtTime(item.at)),
                      h(Button, { variant: 'ghost', size: 'xs', disabled: busy, title: '编辑这条评论', 'data-comment-edit': item.id, onClick: () => startCommentEdit(item) }, '编辑'),
                      h(Button, { variant: 'ghost', size: 'xs', disabled: busy, title: '删除这条评论', 'data-comment-delete': item.id, onClick: () => void removeComment(item) }, '删除'),
                    ),
                  ),
                  commentEdit !== null && commentEdit.id === item.id
                    ? h('div', { className: 'flex min-w-0 flex-col gap-2' },
                      h(TextAreaField, {
                        rows: 3, value: commentEdit.body, 'aria-label': '编辑评论',
                        onChange: event => setCommentEdit({ ...commentEdit, body: event.target.value }),
                      }),
                      h('div', { className: 'flex justify-end gap-2' },
                        h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setCommentEdit(null) }, '取消'),
                        h(Button, { variant: 'primary', size: 'sm', disabled: busy || commentEdit.body.trim() === '', onClick: () => void saveCommentEdit() }, '保存'),
                      ),
                    )
                    : h('div', {
                      className: 'md-content min-w-0 rounded-xl border border-l-2 border-separator-border p-2 text-body-2-regular leading-relaxed '
                        + (human ? 'bg-background-secondary-default ' : 'bg-background-primary-default ')
                        + roleRail,
                    },
                      bodyNodes.length === 0 ? h('span', { className: HINT }, '（这条评论没有正文）') : bodyNodes),
                ),
              )
            }),
          ),
      ),
        ),
      ),
      ),
      pane === 'discuss' ? h('div', { className: 'flex shrink-0 flex-col gap-2 border-t border-separator-border bg-background-primary-default px-5 pt-3 pb-4', 'data-drawer-foot': '' },
        h('div', { className: 'flex flex-wrap items-center gap-2', 'data-drawer-mention-bar': '' },
          h(Button, {
            variant: 'secondary', size: 'sm', disabled: busy,
            onClick: () => { setActive(0); setPicker(current => (current === null || current.inline) ? { query: '', from: null, inline: false } : null) },
          }, picker === null ? `@ 提到谁（${roster.length}）` : '收起名单'),
          h('span', { className: HINT }, '也可以在输入框里直接打「@」搜'),
        ),
        picker !== null
          ? h(MentionPicker, {
            roster,
            query: picker.query,
            active,
            onActive: setActive,
            onQuery: next => { setPicker(current => (current === null ? { query: next, from: null, inline: false } : { ...current, query: next })); setActive(0) },
            onPick: pick,
            onClose: () => setPicker(null),
          })
          : null,
        h('div', { className: 'flex min-w-0 flex-col gap-2', 'data-drawer-composer': '' },
        h(TextAreaField, {
          style: { minHeight: 58 },
          placeholder: '支持 Markdown：`# 标题`、`**粗体**`、`` `代码` ``、``` 代码块 ```、`- 列表`、`| 表格 |`；打「@」选专家派活。',
          value: comment,
          onFocus: () => setPane('discuss'),
          onChange: e => { setComment(e.target.value); refreshPicker(e.target.value, e.target.selectionStart ?? e.target.value.length) },
          onKeyDown: e => {
            if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 'NumpadEnter')) {
              e.preventDefault()
              void send()
              return
            }
            if (picker === null || picker.inline !== true) return
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (hits.length === 0) return
              setActive(current => (current + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length)
            } else if (e.key === 'Enter' && hits.length > 0) {
              e.preventDefault()
              pick(hits[Math.min(active, hits.length - 1)].name)
            } else if (e.key === 'Escape') {
              e.preventDefault(); setPicker(null)
            }
          },
        }),
        h('div', { className: 'flex flex-wrap items-center gap-2 border-t border-separator-border pt-2' },
          h('span', { className: HINT + ' mr-auto' }, 'Markdown 可用 · 打 @ 派活 · Ctrl/⌘+Enter 发送'),
          h('span', { className: 'shrink-0 text-caption-1-regular text-text-tertiary tabular-nums' }, comment.trim() === '' ? '还没写' : `${comment.length} 字`),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy || comment.trim() === '', onClick: () => void send() }, busy ? '发送中…' : '发表评论'),
        ),
        notice !== null ? h('span', { className: OK_TEXT }, notice) : null,
        error !== null ? h('span', { className: ERR_TEXT }, error) : null,
        ),
      ) : null,
    ),
  )
}

  return Drawer
}
