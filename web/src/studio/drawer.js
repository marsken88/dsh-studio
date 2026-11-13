/* Card detail drawer: overview, content, plan, artifacts, tests, runs and talk. */

import { ARTIFACT_KINDS, ARTIFACT_KIND_LABEL, ARTIFACT_STATUS, ARTIFACT_STATUS_LABEL, CASE_PRIORITIES, CASE_RESULT_LABEL, CASE_RESULTS, CASE_TYPES, CASE_TYPE_LABEL, CODING_REVIEW_LABEL, PRIORITY_LABEL, ROLE_LABEL, SEVERITY_LABEL, TYPE_LABEL } from './labels.js'
import { artifactsWithoutBody, buildRoster, cardOwner, filterRoster, fromDateInput, ownerLabel, toDateInput } from './roster.js'
import { fmtTime } from './format.js'
import { parseSteps } from './cases.js'

export function createDrawer({ h, React, api, kit, currentUser, renderMarkdown, tipOf, tipLabel, confirmDialog, promptDialog, TextField, TextAreaField, ChipField, CheckField, SelectField, MdField, MentionPicker }) {
function Drawer({ task, state, onClose, onChanged }) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [comment, setComment] = React.useState('')
  const [notice, setNotice] = React.useState(null)
  const [picked, setPicked] = React.useState('')
  const bodyRef = React.useRef(null)
  // Esc 关抽屉：抽屉占满右侧，没有它只能去点右上角的小 ×。
  React.useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const [plan, setPlan] = React.useState({
    project: task.project ?? '',
    iteration: task.iteration ?? '',
    service: task.service ?? '',
    owner: task.owner ?? '',
    due: toDateInput(task.dueAt),
    releaseId: task.releaseId ?? '',
  })
  const [newItem, setNewItem] = React.useState('')
  const [artifact, setArtifact] = React.useState({ kind: 'doc', title: '', ref: '', content: '' })
  const [artEdit, setArtEdit] = React.useState(null)
  const [artRead, setArtRead] = React.useState(null)
  // 正文不随轮询下发（一条能到几十 KB），点「阅读 / 正文」时才单独取，取过的缓存在这里。
  const [artBodies, setArtBodies] = React.useState({})
  React.useEffect(() => { setArtBodies({}); setArtRead(null); setArtEdit(null) }, [task.id])
  const [newCase, setNewCase] = React.useState({ title: '', expected: '', steps: '', stepsText: '', type: 'functional', priority: 'p2', preconditions: '' })
  const [caseRun, setCaseRun] = React.useState({ busy: false, note: '' })
  const [caseGen, setCaseGen] = React.useState({ busy: false, note: '' })
  const [codingDraft, setCodingDraft] = React.useState(null)
  const [reviewNote, setReviewNote] = React.useState('')
  const coding = task.coding ?? null
  const worktree = task.worktree ?? null
  const [worktreeMsg, setWorktreeMsg] = React.useState('')
  const [verify, setVerify] = React.useState({ busy: false, line: '', ok: null })
  const cases = task.cases ?? []
  const [gate, setGate] = React.useState(null)
  const [gateNote, setGateNote] = React.useState('')
  const casePass = cases.filter(item => item.result === 'pass').length
  const caseFail = cases.filter(item => item.result === 'fail').length
  const caseRest = cases.length - casePass - caseFail
  const caseSummary = cases.length === 0
    ? ''
    : `${cases.length} 条 · ✅ 通过 ${casePass} · ❌ 不通过 ${caseFail}${caseRest > 0 ? ` · ⬜ 没跑 ${caseRest}` : ''}`
  const checklist = task.checklist ?? []
  const doneCount = checklist.filter(item => item.done).length
  const artifacts = task.artifacts ?? []
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
  const editArtifact = async (item) => {
    if (artEdit !== null && artEdit.id === item.id) { setArtEdit(null); return }
    try { setArtEdit({ id: item.id, content: await loadArtifactBody(item) }) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const comments = task.comments ?? []
  const [pane, setPane] = React.useState('overview')
  React.useEffect(() => { setPane('overview') }, [task.id])
  // 切页签时把内容滚回顶部，否则从长页面切到「讨论」会停在中间，看起来像只显示了半截。
  React.useEffect(() => {
    const node = bodyRef.current
    if (node !== null) node.scrollTop = 0
  }, [pane, task.id])
  const hideWhen = name => (pane === name ? undefined : { display: 'none' })
  const tabs = [
    { id: 'overview', label: '概览', hint: '标题、状态、负责人、阻塞原因与关键时间' },
    { id: 'content', label: '内容', hint: '需求正文与验收标准，支持 Markdown' },
    { id: 'plan', label: '计划', hint: '项目、迭代、服务、挂哪条需求、优先级' },
    { id: 'deliver', label: '交付物', count: artifacts.length > 0 ? artifacts.length : '', hint: '文档 / MR / 用例 / 报告；空的交付物会被准出拦下' },
    { id: 'test', label: '测试', count: cases.length > 0 ? `${casePass}/${cases.length}` : (checklist.length > 0 ? `☑${doneCount}/${checklist.length}` : ''), hint: '验收清单、用例执行记录；失败的用例会自动开缺陷' },
    { id: 'coding', label: '执行记录', count: coding === null ? '' : (coding.review?.status === 'approved' ? '✓ 已评审' : ''), hint: 'AI 的分支、提交、改动文件；可以「核对代码事实」' },
    { id: 'discuss', label: '讨论', count: comments.length > 0 ? comments.length : '', hint: '评论；在评论里 @ 专家或专家团即派单' },
  ]
  const [draft, setDraft] = React.useState({ title: task.title, requirement: task.requirement, gitlabIssue: task.gitlabIssue, gitlabMR: task.gitlabMR?.url ?? '', pointId: task.pointId ?? '' })

  const push = async (patch) => {
    setBusy(true); setError(null)
    try {
      await api('/task/update', { id: task.id, patch })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
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
      const out = await api('/task/comment', { id: task.id, body: comment, author: '人', kind: 'human' })
      const told = (out.mentions ?? []).map(mention => mention.label ?? mention.id)
      setComment('')
      if (told.length > 0) setError(null)
      setNotice(told.length > 0 ? `已通知 ${told.join('、')}` : null)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const mention = name => setComment(previous => previous.replace(/\s*$/, previous.length === 0 ? '' : ' ') + `@${name} `)
  // 打「@」就地补全：只在光标前最后一个词是 @开头时给建议，选中后替换掉这半截词。
  const [picker, setPicker] = React.useState(null)
  const [active, setActive] = React.useState(0)
  const roster = React.useMemo(() => buildRoster(state.config), [state.config])
  const hits = picker === null ? [] : filterRoster(roster, picker.query)
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
    try { await api('/agents/run', { id: task.id, expert: picked }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
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
    setBusy(true); setError(null)
    try { await api('/task/checklist', { id: task.id, action: 'remove', itemId: item.id }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const addCase = async () => {
    const title = newCase.title.trim()
    if (title === '') return
    setBusy(true); setError(null)
    try {
      const steps = parseSteps(newCase.steps)
      const item = { title, expected: newCase.expected.trim() }
      if (steps.length > 0) item.http = { steps }
      if (newCase.type !== undefined && newCase.type !== 'functional') item.type = newCase.type
      if (newCase.priority !== undefined && newCase.priority !== 'p2') item.priority = newCase.priority
      if (String(newCase.preconditions ?? '').trim() !== '') item.preconditions = String(newCase.preconditions).trim()
      if (String(newCase.stepsText ?? '').trim() !== '') {
        item.steps = String(newCase.stepsText).split('\n').map(line => line.trim()).filter(line => line !== '')
      }
      await api('/task/case', { id: task.id, action: 'add', cases: [item] })
      setNewCase({ title: '', expected: '', steps: '', stepsText: '', type: 'functional', priority: 'p2', preconditions: '' })
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
      const out = await api('/task/case/run', { id: task.id, caseId, by: '我在界面里跑的' })
      const run = out?.run ?? {}
      const made = (out?.bugs ?? []).filter(item => item.created === true).length
      const parts = [`跑了 ${run.total ?? 0} 条：通过 ${run.passed ?? 0}，不通过 ${run.failed ?? 0}`]
      if (made > 0) parts.push(`自动开缺陷 ${made} 张`)
      setCaseRun({ busy: false, note: parts.join('，') })
      await onChanged()
    } catch (cause) {
      setCaseRun({ busy: false, note: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  const generateCases = async () => {
    setCaseGen({ busy: true, note: '' })
    setError(null)
    try {
      const out = await api('/task/cases/generate', { id: task.id })
      const note = out?.added > 0
        ? `已生成 ${out.added} 条用例，这张卡现在共 ${out.total} 条`
        : `没生成用例：${out?.reason ?? '没有可用的验收条件'}`
      setCaseGen({ busy: false, note })
      await onChanged()
    } catch (cause) {
      setCaseGen({ busy: false, note: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  const removeCase = async (item) => {
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
      setNotice('已登记，正在归档到飞书云盘…')
      await onChanged()
      try {
        const synced = await api('/task/artifact/sync', { id: task.id })
        const first = (synced?.written ?? [])[0]
        setNotice(first?.doc?.url ? `已归档到飞书云盘：${first.doc.url}` : '归档失败，稍后可点「同步到云盘」重试。')
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
        setNotice(doc?.url ? `正文已更新并同步：${doc.url}` : '正文已保存，归档失败可再点「更新」。')
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
      setNotice(doc?.url ? `已归档：${doc.url}` : `归档失败：${failed?.error ?? '未知原因'}`)
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
    try { await api('/task/coding', { id: task.id, action: 'review', status, note: reviewNote.trim() }); setReviewNote(''); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const mergeCoding = async () => {
    setBusy(true); setError(null)
    try { await api('/task/coding', { id: task.id, action: 'merge' }); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
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

  const columnLabel = (state.statuses.find(item => item.id === task.status) ?? {}).label ?? task.status
  const assignee = task.dispatch?.expert ? ownerLabel(state.config ?? {}, { kind: 'expert', id: task.dispatch.expert }) : ''
  return h('div', { className: 'ds-drawer-wrap', onClick: event => { if (event.target === event.currentTarget) onClose() } },
    h('div', { className: 'ds-drawer' },
      h('div', { className: 'ds-dw-head' },
        h('div', { className: 'ds-grow' },
          h('div', { className: 'ds-dw-title' }, task.title),
          h('div', { className: 'ds-dw-sub' }, `${task.id} · ${columnLabel}${assignee === '' ? '' : ` · ${assignee}`} · 更新 ${fmtTime(task.updatedAt)}`),
        ),
        h('button', { className: 'ds-btn', onClick: onClose }, '关闭'),
        (Number(task.agentFailures) || 0) > 0
          ? tipOf(
            task.retryAt > 0 ? `下一次自动重试：${fmtTime(task.retryAt)}` : '失败次数已用完，重置后可以重新派单',
            h('button', {
              className: 'ds-btn',
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
            className: 'ds-dw-shadcn-tabs',
          })
        : h('div', { className: 'ds-dw-tabs' },
          tabs.map(tab => h('button', {
            key: tab.id, className: 'ds-dw-tab', 'data-on': pane === tab.id ? '1' : '0',
            onClick: () => setPane(tab.id),
          }, tab.label, tab.count === '' || tab.count === undefined || tab.count === null ? null : h('span', { className: 'ds-dw-tab-count' }, String(tab.count)))),
        )),
      h('div', { className: 'ds-dw-body', ref: bodyRef, 'data-pane': pane },
      h('div', { className: 'ds-meta' },
        h(ChipField, { className: 'ds-chip' }, task.id),
        task.type === 'bug'
          ? h(ChipField, { className: 'ds-chip ds-chip-bug', 'data-sev': task.severity ?? 'p2' }, `BUG ${String(task.severity || 'p2').toUpperCase()}`)
          : h(ChipField, { className: 'ds-chip' }, TYPE_LABEL[task.type] ?? task.type),
        h(ChipField, { className: 'ds-chip' }, `当前列：${state.statuses.find(c => c.id === task.status)?.label ?? task.status}`),
        h(ChipField, {
          className: 'ds-chip',
          'data-role': (task.dispatch?.state === 'running' && task.dispatch?.expert) ? undefined : task.role,
          'data-open': cardOwner(task, state.config ?? {}).label === '未指派' ? '1' : '0',
          title: cardOwner(task, state.config ?? {}).note,
        }, `负责：${cardOwner(task, state.config ?? {}).label}`),
        task.type === 'bug'
          ? h(SelectField, {
            className: 'ds-select', style: { height: 20, fontSize: 11, padding: '0 4px' }, value: task.severity || 'p2',
            title: '严重级别', onChange: event => void push({ severity: event.target.value }),
          }, ['p0', 'p1', 'p2', 'p3'].map(value => h('option', { key: value, value }, SEVERITY_LABEL[value])))
          : null,
        h(ChipField, { className: 'ds-chip' }, PRIORITY_LABEL[task.priority] ?? task.priority),
        h(ChipField, {
          className: 'ds-chip', title: '点一下改业务领域（决定派给同领域专家）', style: { cursor: 'pointer' },
          onClick: async () => {
            const next = await promptDialog('业务领域（如 支付 / 风控 / 会员），留空表示不限', { title: '改业务领域', defaultValue: task.domain || '' })
            if (next !== null) void push({ domain: next })
          },
        }, task.domain ? `领域：${task.domain}` : '领域：未标'),
        h('span', {}, `创建 ${fmtTime(task.createdAt)}`),
        h('span', {}, `更新 ${fmtTime(task.updatedAt)}`),
      ),
      h('div', { className: 'ds-dw-cols' },
        h('div', { className: 'ds-dw-col' },
      h('div', { className: 'ds-sec', style: hideWhen('overview') },
        h('div', { className: 'ds-sec-head' }, '推进到', h('span', { className: 'ds-hint' }, '点一下就会移动卡片，并触发对应列的 AI')),
        h('div', { className: 'ds-listrow-actions' }, (() => {
          const order = state.statuses
          const currentIndex = order.findIndex(item => item.id === task.status)
          const forward = order[currentIndex + 1] ?? null
          const rest = order.filter(item => item.id !== task.status && (forward === null || item.id !== forward.id))
          const later = rest.filter(item => order.findIndex(o => o.id === item.id) > currentIndex)
          const earlier = rest.filter(item => order.findIndex(o => o.id === item.id) < currentIndex)
          return [
            forward === null
              ? null
              : h('button', {
                key: 'next', className: 'ds-btn ds-btn-primary', disabled: busy,
                title: '推进到下一列，下一列的 AI 会接手',
                onClick: () => void push({ status: forward.id, role: forward.role }),
              }, `推进到「${forward.label}」`),
            rest.length === 0 ? null : h(SelectField, {
              key: 'other', className: 'ds-select', value: '', disabled: busy,
              onChange: event => {
                const id = event.target.value
                if (id === '') return
                const target = order.find(item => item.id === id)
                if (target !== undefined) void push({ status: target.id, role: target.role })
              },
            },
              h('option', { value: '' }, `其他状态（${rest.length}）`),
              ...later.map(item => h('option', { key: item.id, value: item.id }, `→ ${item.label}`)),
              ...earlier.map(item => h('option', { key: item.id, value: item.id }, `← ${item.label}（退回，AI 会重跑）`)),
            ),
          ].filter(Boolean)
        })()),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('overview') },
        h('div', { className: 'ds-sec-head' }, '准出检查',
          h('span', { className: 'ds-hint' }, '进「已完成」之前必须过这一关：清单全勾、没有失败用例、不在阻塞、有人签字')),
        h('div', { className: 'ds-sec-body' },
          gate === null
            ? h('div', { className: 'ds-row', style: { gap: 8, alignItems: 'center' } },
                h('button', { className: 'ds-btn', onClick: () => void checkGate() }, '检查一下'),
                h('span', { className: 'ds-hint' }, '点一下看这张卡还差什么才能收口'))
            : h('div', { className: 'ds-gate', 'data-ready': gate.ready ? '1' : '0' },
                h('div', { className: 'ds-gate-head' },
                  h('b', null, gate.ready ? '✅ 可以进「已完成」' : `⛔ 还差 ${gate.blockers.length} 项`),
                  h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void checkGate() }, '重新检查')),
                (gate.blockers ?? []).map(line => h('div', { key: line, className: 'ds-gate-item', 'data-kind': 'block' }, `⛔ ${line}`)),
                (gate.warnings ?? []).map(line => h('div', { key: line, className: 'ds-gate-item', 'data-kind': 'warn' }, `⚠ ${line}`)),
                (gate.blockers ?? []).length === 0 && (gate.warnings ?? []).length === 0
                  ? h('div', { className: 'ds-hint' }, '没有遗留项。') : null),
          task.signoff === null || task.signoff === undefined
            ? h('div', { className: 'ds-row', style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h(TextField, {
                  className: 'ds-input',
                  style: { flex: '1 1 260px' },
                  value: gateNote,
                  placeholder: '验收签字：验了什么、遗留什么',
                  onChange: event => setGateNote(event.target.value),
                }),
                h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void signOff('sign') }, '签字确认'))
            : h('div', { className: 'ds-gate-sign' },
                h('span', null, `✍ ${task.signoff.by} 于 ${new Date(task.signoff.at).toLocaleString()} 签字：${task.signoff.note}`),
                h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void signOff('clear') }, '取消签字')),
        ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('overview') },
        h('div', { className: 'ds-sec-head' }, '阻塞',
          h('span', { className: 'ds-hint' }, '卡住了打个标，卡留在本列停住，不会被自动往下派；怎么继续由人定')),
        blocked === null
          ? h('div', { className: 'ds-sec-body' },
            h('div', { className: 'ds-hint' }, '缺信息、缺权限、等外部依赖、测试过不去——都可以标阻塞，别硬编。'),
            h('div', { className: 'ds-listrow-actions' },
              h('button', { className: 'ds-btn ds-btn-ghost', 'data-warn': '1', disabled: busy, onClick: () => void markBlocked() }, '⛔ 标记阻塞'),
            ),
          )
          : h('div', { className: 'ds-sec-body' },
            h('div', { className: 'ds-blocked-box' },
              h('div', { style: { fontWeight: 600 } }, `⛔ ${blocked.reason || '未填写原因'}`),
              h('div', { className: 'ds-hint' }, `${blocked.by || '人'} · ${fmtTime(blocked.at)} · 停在「${state.statuses.find(c => c.id === task.status)?.label ?? task.status}」`),
            ),
            h('div', { className: 'ds-hint' }, '怎么继续：'),
            h('div', { className: 'ds-listrow-actions' },
              h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void resolveBlocked('resume') }, '继续，交本列负责人'),
              h('button', { className: 'ds-btn', disabled: busy, onClick: () => void resolveBlocked('advance') }, '推进到下一列'),
              h(SelectField, {
                className: 'ds-select', style: { width: 190 }, value: picked, disabled: busy,
                onChange: e => setPicked(e.target.value),
              },
                h('option', { value: '' }, '选一个专家…'),
                (state.config?.experts ?? []).filter(expert => expert.enabled !== false).map(expert =>
                  h('option', { key: expert.id, value: expert.id }, `${expert.emoji} ${expert.name}`)),
              ),
              h('button', { className: 'ds-btn', disabled: busy || picked === '', onClick: () => void resolveBlocked('assign', picked) }, '改派给他'),
              h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void resolveBlocked('clear') }, '只解除，先不派'),
            ),
          ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('overview') },
        h('div', { className: 'ds-sec-head' }, 'AI 处理', h('span', { className: 'ds-hint' }, '默认用本列负责人；也可以临时换人')),
        h('div', { className: 'ds-sec-body' },
          h('div', { className: 'ds-hint' },
            task.dispatch?.state === 'running'
              ? `${ownerLabel(state.config ?? {}, { kind: 'expert', id: task.dispatch.expert ?? task.dispatch.role }) || 'AI'} 处理中 · 起于 ${fmtTime(task.dispatch.at)}`
              : task.dispatch?.state === 'failed'
                ? `上次派单失败：${task.dispatch.error ?? '未知原因'}`
                : task.dispatch?.state === 'stopped'
                  ? '上次派单已被停止'
                  : '这张卡还没有派给 AI'),
          h('div', { className: 'ds-field', style: { marginTop: 4 } },
            h('div', { className: 'ds-label' }, '派给谁'),
            h(SelectField, {
              className: 'ds-select', value: picked, disabled: busy,
              onChange: e => setPicked(e.target.value),
            },
              h('option', { value: '' }, '用本列负责人'),
              (state.config?.experts ?? []).filter(expert => expert.enabled !== false).map(expert =>
                h('option', { key: expert.id, value: expert.id }, `${expert.emoji} ${expert.name}`)),
            ),
          ),
          h('div', { className: 'ds-listrow-actions', style: { marginTop: 8 } },
            h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void runAgent() }, '马上处理'),
            h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy || task.dispatch?.state !== 'running', onClick: () => void stopAgent() }, '停止'),
          ),
        ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('content') },
        h('div', { className: 'ds-sec-head' }, '内容'),
      h('div', { className: 'ds-field' },
        h('div', { className: 'ds-label' }, '标题'),
        h(TextField, { className: 'ds-input', value: draft.title, onChange: e => setDraft({ ...draft, title: e.target.value }) }),
      ),
      h('div', { className: 'ds-field' },
        h('div', { className: 'ds-label' }, '需求 / 背景 / 验收标准'),
        String(draft.requirement ?? '').trim() === ''
          ? null
          : h('div', { className: 'ds-md-preview ds-reader', 'data-task-md': '1', style: { maxHeight: 220 } }, renderMarkdown(draft.requirement)),
        h(MdField, {
          className: 'ds-textarea',
          rows: String(draft.requirement ?? '').trim() === '' ? 4 : 8,
          value: draft.requirement,
          placeholder: '这张卡要解决什么、背景是什么、做到什么算完成——AI 接手前最好写清楚。',
          onChange: e => setDraft({ ...draft, requirement: e.target.value }),
        }),
        String(draft.requirement ?? '').trim() === ''
          ? h('div', { className: 'ds-hint' }, '这张卡还没有需求描述：专家只能按标题猜。补完点下面的「保存改动」。')
          : null,
      ),
      h('div', { className: 'ds-field' },
        h('div', { className: 'ds-label' }, '对应功能点'),
        (() => {
          const req = (state.requirements ?? []).find(item => item.id === task.requirementId)
          if (req === undefined) return h('div', { className: 'ds-hint' }, '这张卡还没挂需求，先在「计划」里挂到某个需求，才能选功能点。')
          const points = req.points ?? []
          if (points.length === 0) return h('div', { className: 'ds-hint' }, `需求 ${req.code || req.id} 还没拆功能点，去需求页「功能点与可追溯矩阵」加几条。`)
          return h(SelectField, {
            className: 'ds-select',
            value: draft.pointId ?? '',
            onChange: event => setDraft({ ...draft, pointId: event.target.value }),
          },
            h('option', { value: '' }, '不归到具体功能点'),
            points.map(point => h('option', { key: point.id, value: point.id }, `${point.id} ${point.title}`)),
          )
        })(),
      ),
      h('div', { className: 'ds-row' },
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, 'GitLab Issue'),
          h(TextField, { className: 'ds-input', value: draft.gitlabIssue, onChange: e => setDraft({ ...draft, gitlabIssue: e.target.value }) }),
        ),
        h('div', { className: 'ds-field', style: { flex: 1 } },
          h('div', { className: 'ds-label' }, 'GitLab MR'),
          (task.gitlabMR?.iid ?? 0) > 0
            ? h('div', { className: 'ds-art-row', style: { padding: '6px 0', borderBottom: 'none' } },
                h(ChipField, { className: 'ds-chip', 'data-on': task.gitlabMR.state === 'opened' ? '1' : undefined }, `MR !${task.gitlabMR.iid} · ${task.gitlabMR.state}`),
                h('div', { className: 'ds-grow' },
                  h('div', { className: 'ds-art-title' }, task.gitlabMR.title || `MR !${task.gitlabMR.iid}`),
                  task.gitlabMR.url === '' ? null : h('div', { className: 'ds-art-ref' }, task.gitlabMR.url),
                  (task.gitlabMR.sourceBranch ?? '') === '' ? null : h('div', { className: 'ds-art-ref' }, `分支 ${task.gitlabMR.sourceBranch} → ${task.gitlabMR.targetBranch || '—'}`),
                  task.gitlabMR.pipeline === null || task.gitlabMR.pipeline === undefined ? null : h('div', { className: 'ds-art-ref' },
                    h(ChipField, { className: 'ds-chip', 'data-sla': task.gitlabMR.pipeline.status === 'failed' ? 'overdue' : undefined }, `流水线 ${task.gitlabMR.pipeline.status}`),
                    ' ',
                    task.gitlabMR.pipeline.url === '' ? null : h('a', { className: 'ds-link', href: task.gitlabMR.pipeline.url, target: '_blank', rel: 'noreferrer' }, `#${task.gitlabMR.pipeline.id}`),
                  ),
                ),
              )
            : h(TextField, { className: 'ds-input', placeholder: '还没关联 MR；提了 MR 后会自动同步', value: draft.gitlabMR, onChange: e => setDraft({ ...draft, gitlabMR: e.target.value }) }),
        ),
      ),
      h('div', { className: 'ds-row' },
        h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void push((task.gitlabMR?.iid ?? 0) > 0 ? { ...draft, gitlabMR: undefined } : draft) }, '保存改动'),
        h('button', { className: 'ds-btn', disabled: busy, onClick: remove }, '只删卡'),
      ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('plan') },
        h('div', { className: 'ds-sec-head' }, '计划',
          h('span', { className: 'ds-hint' }, '这张卡属于哪个项目/迭代、谁提的、什么时候要')),
        h('div', { className: 'ds-sec-body' },
          h('div', { className: 'ds-row' },
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '业务项目'),
              h(SelectField, {
                className: 'ds-select', value: plan.project,
                onChange: event => setPlan({ ...plan, project: event.target.value, iteration: '', service: '' }),
              },
                h('option', { value: '' }, '不属于任何项目'),
                (state.config?.projects ?? []).map(item => h('option', { key: item.id, value: item.id }, `${item.key ? `${item.key} · ` : ''}${item.name}`)),
              ),
            ),
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '迭代'),
              h(SelectField, {
                className: 'ds-select', value: plan.iteration,
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
            : h('div', { className: 'ds-field' },
              h('div', { className: 'ds-label' }, '服务（决定用哪个 git 路径切 worktree）'),
              h(SelectField, {
                className: 'ds-select', value: plan.service ?? '',
                onChange: event => setPlan({ ...plan, service: event.target.value }),
              },
                h('option', { value: '' }, '用项目级默认目录'),
                ((state.config?.projects ?? []).find(item => item.id === plan.project)?.services ?? [])
                  .map(item => h('option', { key: item.id, value: item.id }, `${item.name}${item.repoPath ? ` · ${item.repoPath}` : ''}`)),
              ),
              h('div', { className: 'ds-hint' }, '一个项目有多个服务（每个服务一个 git 路径）时，这里决定这张卡改哪个服务。'),
            ),
          h('div', { className: 'ds-row' },
            h('div', { className: 'ds-field', style: { flex: 2 } },
              h('div', { className: 'ds-label' }, '业务负责人'),
              h(TextField, {
                className: 'ds-input', value: plan.owner, placeholder: '提需求的人，例如 张伟',
                onChange: event => setPlan({ ...plan, owner: event.target.value }),
              }),
            ),
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '期望完成'),
              h(TextField, {
                className: 'ds-input', type: 'date', value: plan.due,
                onChange: event => setPlan({ ...plan, due: event.target.value }),
              }),
            ),
          ),
          h('div', { className: 'ds-row' },
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '所属版本'),
              h(SelectField, {
                className: 'ds-select', value: plan.releaseId,
                onChange: event => setPlan({ ...plan, releaseId: event.target.value }),
              },
                h('option', { value: '' }, '不挂版本'),
                (state.releases ?? []).map(item => h('option', { key: item.id, value: item.id }, `${item.version || item.id} ${item.name}`.trim())),
              ),
            ),
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '编号'),
              h('div', { className: 'ds-hint' }, task.code === '' ? '—（未挂需求）' : task.code),
            ),
          ),
          h('div', { className: 'ds-listrow-actions' },
            h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void savePlan() }, '保存计划'),
            task.dueAt > 0 && task.dueAt < Date.now() && task.status !== 'done'
              ? h('span', { className: 'ds-err' }, '已逾期')
              : null,
          ),
        ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('plan') },
        h('div', { className: 'ds-sec-head' }, '代码隔离（git worktree）',
          h('span', { className: 'ds-hint' }, worktree === null ? '这张卡还没有独立工作目录' : '这张卡自己的分支与目录')),
        h('div', { className: 'ds-sec-body' },
          worktree === null
            ? h('div', { className: 'ds-field' },
              h('div', { className: 'ds-hint' }, '开启「代码隔离 = worktree」并给项目配好本机代码目录后，派单会自动切一条 task/<编号> 分支；也可以先手动建一个。'),
              h('div', { className: 'ds-listrow-actions' },
                h('button', { className: 'ds-btn', disabled: busy, onClick: () => void worktreeAction('create') }, '建 worktree'),
              ),
            )
            : h('div', { className: 'ds-field' },
              h('div', { className: 'ds-code-line' }, `${worktree.branch} · 基线 ${worktree.base}`),
              h('div', { className: 'ds-code-line' }, worktree.path),
              h('div', { className: 'ds-hint' }, `仓库 ${worktree.repo}${worktreeMsg ? ` · ${worktreeMsg}` : ''}`),
              h('div', { className: 'ds-listrow-actions' },
                h('button', { className: 'ds-btn', disabled: busy, onClick: () => void worktreeAction('list') }, '看 git worktree 列表'),
                h('button', { className: 'ds-btn', disabled: busy, onClick: () => void worktreeAction('remove') }, '回收 worktree'),
              ),
            ),
          worktreeMsg && worktree === null ? h('div', { className: 'ds-hint' }, worktreeMsg) : null,
        ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('coding') },
        h('div', { className: 'ds-sec-head' }, 'AI Coding 执行记录',
          h('span', { className: 'ds-hint' }, coding === null ? '改代码要留记录：谁、什么模型、改了什么' : '研发 agent 登记，人也可以补录或评审')),
        h('div', { className: 'ds-sec-body' },
          coding === null
            ? h('div', { className: 'ds-empty' }, '还没有执行记录。')
            : h('div', { className: 'ds-code-box' },
              h('div', { className: 'ds-code-head' },
                h(ChipField, { className: 'ds-chip', 'data-review': coding.review.status }, CODING_REVIEW_LABEL[coding.review.status] ?? coding.review.status),
                h('div', { className: 'ds-grow' },
                  h('div', { className: 'ds-code-line' }, [coding.agent || '未登记 agent', coding.model, coding.branch].filter(Boolean).join(' · ')),
                  coding.context === '' ? null : h('div', { className: 'ds-hint' }, coding.context),
                ),
                h('span', { className: 'ds-hint' }, coding.unitTests.total > 0 ? `单测 ${coding.unitTests.passed}/${coding.unitTests.total}` : '无单测'),
                worktree === null ? null : tipOf(
                  '拿 worktree 里的 git 记录，比执行记录里自报的提交 / 文件 / 分支',
                  h('button', {
                    className: 'ds-btn ds-btn-ghost', disabled: busy || verify.busy,
                    onClick: () => void verifyCoding(),
                  }, verify.busy ? '核对中…' : (verify.line === '' ? '核对代码事实' : '再核对一次')),
                ),
              ),
              verify.line === ''
                ? (coding.verified === null || coding.verified === undefined
                  ? null
                  : h('div', { className: 'ds-hint', 'data-verify': coding.verified.ok ? 'ok' : 'bad', style: { marginTop: 6 } },
                    `${coding.verified.ok ? '✅' : '⚠'} 上次核对 ${fmtTime(coding.verified.at)}：分支 ${coding.verified.branch} · 提交 ${coding.verified.commitCount.actual} 个 · 改动 ${coding.verified.fileCount.actual} 个文件` +
                    `${coding.verified.missingCommits.length + coding.verified.missingFiles.length === 0 ? '' : ` · ${coding.verified.missingCommits.length + coding.verified.missingFiles.length} 项对不上`}`))
                : h('div', { className: 'ds-hint', 'data-verify': verify.ok === true ? 'ok' : 'bad', style: { marginTop: 6 } },
                  `${verify.ok === true ? '✅' : '⚠'} ${verify.line}`),
              (coding.commits ?? []).length === 0 ? null : h('div', { className: 'ds-code-list' },
                coding.commits.slice(0, 6).map(item => h('div', { key: item.id, className: 'ds-code-item' },
                  h('code', null, item.sha.slice(0, 8)),
                  h('span', { className: 'ds-grow' }, item.message || '(无提交说明)'),
                  h('span', { className: 'ds-hint' }, `${item.files} 文件`),
                )),
                coding.commits.length > 6 ? h('div', { className: 'ds-hint' }, `还有 ${coding.commits.length - 6} 次提交`) : null,
              ),
              (coding.files ?? []).length === 0 ? null : h('div', { className: 'ds-code-files' },
                coding.files.slice(0, 12).map(item => h('span', { key: item.id, className: 'ds-code-file', 'data-change': item.change },
                  `${item.path}${item.additions > 0 ? ` +${item.additions}` : ''}${item.deletions > 0 ? ` -${item.deletions}` : ''}`)),
                coding.files.length > 12 ? h('span', { className: 'ds-hint' }, `还有 ${coding.files.length - 12} 个`) : null,
              ),
              coding.review.note === '' ? null : h('div', { className: 'ds-code-note' }, `评审意见：${coding.review.note}`),
              h('div', { className: 'ds-row' },
                h(TextField, {
                  className: 'ds-input', style: { flex: 1 }, value: reviewNote, placeholder: '评审意见（可选，写清文件/行为什么/怎么改）',
                  onChange: event => setReviewNote(event.target.value),
                }),
                h('button', { className: 'ds-btn', disabled: busy, onClick: () => void reviewCoding('approved') }, '评审通过'),
                h('button', { className: 'ds-btn', disabled: busy, onClick: () => void reviewCoding('changes_requested') }, '要求修改'),
                coding.mergedAt > 0
                  ? h('span', { className: 'ds-hint' }, `已合并 · ${coding.mergedBy || '—'}`)
                  : h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void mergeCoding() }, '标记已合并'),
              ),
            ),
          codingDraft === null
            ? h('div', { className: 'ds-row' },
              h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: openCoding }, coding === null ? '手动补录执行记录' : '编辑执行记录'))
            : h('div', null,
              h('div', { className: 'ds-row' },
                h('div', { className: 'ds-field', style: { flex: 1 } },
                  tipLabel('Coding Agent', '这次改代码的 agent 名字，只作记录，不影响派单'),
                  h(TextField, { className: 'ds-input', value: codingDraft.agent, placeholder: 'claude-code / codex / 自研', onChange: e => setCodingDraft({ ...codingDraft, agent: e.target.value }) }),
                ),
                h('div', { className: 'ds-field', style: { flex: 1 } },
                  h('div', { className: 'ds-label' }, '模型'),
                  h(TextField, { className: 'ds-input', value: codingDraft.model, placeholder: 'deepseek-v4.1-flash', onChange: e => setCodingDraft({ ...codingDraft, model: e.target.value }) }),
                ),
                h('div', { className: 'ds-field', style: { flex: 1 } },
                  h('div', { className: 'ds-label' }, '分支'),
                  h(TextField, { className: 'ds-input', value: codingDraft.branch, placeholder: 'feature/xxx', onChange: e => setCodingDraft({ ...codingDraft, branch: e.target.value }) }),
                ),
              ),
              h('div', { className: 'ds-row' },
                h('div', { className: 'ds-field', style: { flex: '0 0 110px' } },
                  tipLabel('单测总数', '这次执行报的单测总数，可以 agent 写回，也可以手填'),
                  h(TextField, { className: 'ds-input', value: codingDraft.total, onChange: e => setCodingDraft({ ...codingDraft, total: e.target.value }) }),
                ),
                h('div', { className: 'ds-field', style: { flex: '0 0 110px' } },
                  tipLabel('通过数', '通过的条数；少于总数时卡片过不了准出'),
                  h(TextField, { className: 'ds-input', value: codingDraft.passed, onChange: e => setCodingDraft({ ...codingDraft, passed: e.target.value }) }),
                ),
                h('div', { className: 'ds-field', style: { flex: 1 } },
                  h('div', { className: 'ds-label' }, '这次依据的上下文'),
                  h(TextField, { className: 'ds-input', value: codingDraft.context, placeholder: '例如 PRD v1.2 + 架构方案 v1', onChange: e => setCodingDraft({ ...codingDraft, context: e.target.value }) }),
                ),
              ),
              h('div', { className: 'ds-row' },
                h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void saveCoding() }, '保存执行记录'),
                h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => setCodingDraft(null) }, '取消'),
              ),
            ),
        ),
      ),
        ),
        h('div', { className: 'ds-dw-col' },
      h('div', { className: 'ds-sec', style: hideWhen('test') },
        h('div', { className: 'ds-sec-head' }, '验收清单',
          h('span', { className: 'ds-hint' }, checklist.length === 0 ? '这张卡还没有清单' : `${doneCount} / ${checklist.length} 已勾`)),
        h('div', { className: 'ds-sec-body' },
          checklist.length === 0 ? null : h('div', { className: 'ds-check-progress' },
            h('div', { className: 'ds-check-bar', 'data-full': doneCount === checklist.length ? '1' : '0' },
              h('span', { style: { width: `${checklist.length === 0 ? 0 : Math.round(doneCount / checklist.length * 100)}%` } }),
            ),
          ),
          checklist.map(item => h('div', { key: item.id, className: 'ds-check-row', 'data-done': item.done ? '1' : '0' },
            h(CheckField, { checked: item.done, disabled: busy,
              onChange: () => void toggleChecklist(item),
            }),
            h('div', { className: 'ds-grow' },
              h('div', { className: 'ds-check-text' }, item.text, h('span', { className: 'ds-hint' }, ` #${item.id}`)),
              item.note || item.by
                ? h('div', { className: 'ds-hint' }, `${item.by ? `${item.by} · ` : ''}${item.at ? fmtTime(item.at) : ''}${item.note ? ` · ${item.note}` : ''}`)
                : null,
            ),
            h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void removeChecklist(item) }, '×'),
          )),
          h('div', { className: 'ds-row' },
            h(TextField, {
              className: 'ds-input', style: { flex: 1 }, value: newItem, placeholder: '再加一条验收条目，回车提交',
              onChange: event => setNewItem(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter') void addChecklist() },
            }),
            h('button', { className: 'ds-btn', disabled: busy || newItem.trim() === '', onClick: () => void addChecklist() }, '＋ 加一条'),
          ),
          h('div', { className: 'ds-hint' }, '清单就是「做完」的定义：AI 每完成一项要勾一项并附证据；人也可以直接勾。'),
        ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('deliver') },
        h('div', { className: 'ds-sec-head' }, '交付物',
          h('span', { className: 'ds-hint' }, '文档、MR、用例、报告——交付要有东西，不只是一句「做完了」；登记后会写成飞书云盘需求文件夹里的一份文档'),
          artifactsWithoutBody(task).length > 0
            ? h('span', { className: 'ds-card-warn', title: '这些交付物还没写正文，点「正文」补上再同步' }, `● ${artifactsWithoutBody(task).length} 件缺正文`)
            : null,
          (task.artifacts ?? []).length > 0
            ? h('button', {
              className: 'ds-btn ds-btn-ghost', disabled: busy,
              title: '把这张卡的交付物全部写进需求文件夹（已归档的会覆盖更新）',
              onClick: () => void syncAllArtifacts(),
            }, '同步到云盘')
            : null),
        h('div', { className: 'ds-sec-body', 'data-scroll': '1' },
          (task.artifacts ?? []).length === 0
            ? h('div', { className: 'ds-empty' }, '还没有交付物。')
            : (task.artifacts ?? []).map(item => h('div', { key: item.id, className: 'ds-art-wrap' }, h('div', { className: 'ds-art-row', 'data-missing': artifactHasBody(item) ? '0' : '1' },
              h(ChipField, { className: 'ds-chip', 'data-kind': item.kind }, ARTIFACT_KIND_LABEL[item.kind] ?? item.kind),
              h('div', { className: 'ds-grow' },
                h('div', { className: 'ds-art-title' },
                  artifactHasBody(item)
                    ? null
                    : h('span', { className: 'ds-card-warn', style: { marginRight: 6 }, title: '这条交付物还没写正文，云盘文档里只有标题' }, '●'),
                  item.title,
                ),
                h('div', { className: 'ds-art-ref' }, `正文 ${typeof item.contentLength === 'number' ? item.contentLength : String(item.content ?? '').length} 字${artifactHasBody(item) ? '' : ' · 缺正文'}${item.doc?.url ? '' : ' · 还没归档'}`),
                item.ref === '' ? null : h('div', { className: 'ds-art-ref' }, item.ref),
                item.doc?.url
                  ? h('a', { className: 'ds-art-ref', href: item.doc.url, target: '_blank', rel: 'noreferrer' }, `📄 ${item.doc.name || '云盘文档'}`)
                  : (item.doc?.error ? h('div', { className: 'ds-error' }, item.doc.error) : null),
              ),
              h('button', {
                className: 'ds-btn ds-btn-ghost', disabled: busy, title: '直接读正文（Markdown 渲染）',
                onClick: () => void readArtifact(item),
              }, artRead === item.id ? '收起' : '阅读'),
              h('button', {
                className: 'ds-btn ds-btn-ghost', disabled: busy, title: '编辑正文',
                onClick: () => void editArtifact(item),
              }, '正文'),
              item.doc?.url
                ? h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, title: '用最新正文覆盖云盘文档', onClick: () => void syncArtifactTo(item) }, '更新')
                : h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, title: '写进需求文件夹', onClick: () => void syncArtifactTo(item) }, '归档'),
              h(SelectField, {
                className: 'ds-select', style: { width: 92, height: 22, fontSize: 11 }, value: item.status, disabled: busy,
                onChange: event => void setArtifactStatus(item, event.target.value),
              }, ARTIFACT_STATUS.map(value => h('option', { key: value, value }, ARTIFACT_STATUS_LABEL[value]))),
              h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void removeArtifact(item) }, '×'),
            ),
            artRead === item.id
              ? h('div', { className: 'ds-md-preview ds-reader' }, artBodies[item.id] === undefined && artifactHasBody(item)
                ? h('span', { className: 'ds-hint' }, '读取中…')
                : artifactBody(item).trim() === ''
                  ? h('span', { className: 'ds-hint' }, '这条交付物还没有正文。')
                  : renderMarkdown(artifactBody(item)))
              : null,
          )),
          artEdit === null ? null : h('div', { style: { marginTop: 8 } },
            h(MdField, {
              className: 'ds-input', style: { width: '100%' }, rows: 8, value: artEdit.content,
              placeholder: '写清楚做了什么、结论、风险。这段会原样写进云盘文档正文。',
              onChange: event => setArtEdit({ ...artEdit, content: event.target.value }),
            }),
            h('div', { className: 'ds-row', style: { justifyContent: 'flex-end', marginTop: 6 } },
              h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => setArtEdit(null) }, '取消'),
              h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void saveArtifactContent({ id: artEdit.id }) }, '保存正文并同步'),
            ),
          ),
          h('div', { className: 'ds-row' },
            h(SelectField, {
              className: 'ds-select', style: { width: 104 }, value: artifact.kind,
              onChange: event => setArtifact({ ...artifact, kind: event.target.value }),
            }, ARTIFACT_KINDS.map(value => h('option', { key: value, value }, ARTIFACT_KIND_LABEL[value]))),
            h(TextField, {
              className: 'ds-input', style: { flex: 1 }, value: artifact.title, placeholder: '交付物名称，例如 登录模块技术方案',
              onChange: event => setArtifact({ ...artifact, title: event.target.value }),
            }),
            h(TextField, {
              className: 'ds-input', style: { flex: 1 }, value: artifact.ref, placeholder: '路径 / 链接 / MR 号',
              onChange: event => setArtifact({ ...artifact, ref: event.target.value }),
            }),
          ),
          h(MdField, {
            className: 'ds-input', style: { width: '100%', marginTop: 6 }, rows: 5, value: artifact.content,
            placeholder: '交付物正文（Markdown）。这段会原样写成云盘文档的正文：做什么、怎么做、结论、风险。留空也能登记，但云盘里只有标题。',
            onChange: event => setArtifact({ ...artifact, content: event.target.value }),
          }),
          h('div', { className: 'ds-row', style: { justifyContent: 'flex-end', marginTop: 6 } },
            h('button', {
              className: 'ds-btn', disabled: busy || artifact.title.trim() === '',
              onClick: () => void addArtifact(),
            }, '登记并归档'),
          ),
        ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('test') },
        h('div', { className: 'ds-sec-head' }, '测试用例',
          h('span', { className: 'ds-hint' }, cases.length === 0
            ? '测试同学把用例登记在这里，逐条执行并回填结果'
            : caseSummary),
          h('button', {
            className: 'ds-btn ds-btn-ghost',
            disabled: caseGen.busy,
            onClick: () => void generateCases(),
          }, caseGen.busy ? '生成中…' : '✨ 按需求生成'),
          h('button', {
            className: 'ds-btn ds-btn-ghost',
            disabled: caseRun.busy || cases.filter(item => item.http != null).length === 0,
            onClick: () => void runCases(undefined),
          }, caseRun.busy ? '运行中…' : '▶ 跑接口用例')),
        h('div', { className: 'ds-sec-body', 'data-scroll': '1' },
          caseRun.note === '' ? null : h('div', { className: 'ds-hint' }, caseRun.note),
          caseGen.note === '' ? null : h('div', { className: 'ds-hint' }, caseGen.note),
          cases.length === 0
            ? h('div', { className: 'ds-empty' }, '还没有用例。')
            : cases.map(item => h('div', { key: item.id, className: 'ds-art-row', 'data-result': item.result },
              h(SelectField, {
                className: 'ds-select', style: { width: 84, height: 22, fontSize: 11 }, value: item.result, disabled: busy,
                onChange: event => void setCaseResult(item, event.target.value),
              }, CASE_RESULTS.map(value => h('option', { key: value, value }, CASE_RESULT_LABEL[value]))),
              h('div', { className: 'ds-grow' },
                h('div', { className: 'ds-art-title' }, item.title),
                h('div', { className: 'ds-row', style: { gap: 6, alignItems: 'center', marginTop: 2 } },
                  h(ChipField, { className: 'ds-chip ds-chip-soft' }, CASE_TYPE_LABEL[item.type ?? 'functional'] ?? '功能'),
                  h(ChipField, { className: 'ds-chip ds-chip-soft', 'data-pri': item.priority ?? 'p2' }, String(item.priority ?? 'p2').toUpperCase()),
                  String(item.preconditions ?? '') === '' ? null : h('span', { className: 'ds-hint' }, `前置：${item.preconditions}`),
                  (item.steps ?? []).length === 0 ? null : h('span', { className: 'ds-hint' }, `步骤 ${item.steps.length} 条`),
                ),
                item.expected === '' ? null : h('div', { className: 'ds-art-ref' }, `期望：${item.expected}`),
                item.http == null ? null : h('div', { className: 'ds-art-ref' }, `接口：${item.http.method} ${item.http.url} → 期望 ${item.http.expectStatus}${item.http.expectContains ? ` 且含 «${item.http.expectContains}»` : ''}`),
                item.lastRun == null ? null : h('div', { className: 'ds-art-ref' }, `${item.lastRun.ok ? '✅' : '❌'} 最近执行：${item.lastRun.status === 0 ? item.lastRun.error : `${item.lastRun.status} · ${item.lastRun.ms}ms`}（${new Date(item.lastRun.at).toLocaleString('zh-CN')}）`),
                item.lastRun?.response ? h('div', { className: 'ds-code-note' }, `响应片段：${String(item.lastRun.response).slice(0, 400)}${String(item.lastRun.response).length > 400 ? '…' : ''}`) : null,
                (item.lastRun?.steps ?? []).length === 0 ? null : h('div', { className: 'ds-art-ref' }, `步骤：${item.lastRun.steps.map(step => `${step.ok ? '✅' : '❌'} ${step.method} ${step.url}${step.status === 0 ? '' : ` → ${step.status}`}`).join('；')}`),
                (item.http?.steps ?? []).length === 0 ? null : h(ChipField, { className: 'ds-chip ds-chip-soft' }, `多步 ${item.http.steps.length}`),
                ((state.requirements ?? []).find(entry => entry.id === task.requirementId)?.points ?? []).length === 0
                  ? (item.pointId ? h('div', { className: 'ds-art-ref' }, `功能点：${item.pointId}`) : null)
                  : h('div', { className: 'ds-row', style: { gap: 6, alignItems: 'center' } },
                      h('span', { className: 'ds-hint' }, '功能点'),
                      h(SelectField, {
                        className: 'ds-select',
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
                item.note === '' ? null : h('div', { className: 'ds-art-ref' }, `记录：${item.note}${item.by ? ` — ${item.by}` : ''}`),
              ),
              item.http == null ? null : h('button', { className: 'ds-btn ds-btn-ghost', disabled: caseRun.busy, onClick: () => void runCases(item.id) }, '▶'),
              h('button', {
                className: 'ds-btn ds-btn-ghost',
                disabled: busy,
                title: '标记为不稳定用例：失败时不自动开缺陷',
                'data-flaky': item.flaky === true ? '1' : '0',
                onClick: () => void toggleFlaky(item),
              }, item.flaky === true ? '不稳' : '标不稳'),
              h('button', { className: 'ds-btn ds-btn-ghost', disabled: busy, onClick: () => void removeCase(item) }, '×'),
            )),
          h('div', { className: 'ds-row' },
            h(TextField, {
              className: 'ds-input', style: { flex: 1 }, value: newCase.title, placeholder: '用例：做什么，例如 用错误密码连续登录 5 次',
              onChange: event => setNewCase({ ...newCase, title: event.target.value }),
            }),
            h(TextField, {
              className: 'ds-input', style: { flex: 1 }, value: newCase.expected, placeholder: '期望结果，例如 第 5 次返回 429 并锁定 10 分钟',
              onChange: event => setNewCase({ ...newCase, expected: event.target.value }),
            }),
            h('button', { className: 'ds-btn', disabled: busy || newCase.title.trim() === '', onClick: () => void addCase() }, '＋ 加用例'),
          ),
          h('div', { className: 'ds-row', style: { gap: 8, flexWrap: 'wrap', marginTop: 6 } },
            h(SelectField, {
              className: 'ds-select', style: { width: 96 }, value: newCase.type ?? 'functional',
              onChange: event => setNewCase({ ...newCase, type: event.target.value }),
            }, CASE_TYPES.map(value => h('option', { key: value, value }, CASE_TYPE_LABEL[value]))),
            h(SelectField, {
              className: 'ds-select', style: { width: 84 }, value: newCase.priority ?? 'p2',
              onChange: event => setNewCase({ ...newCase, priority: event.target.value }),
            }, CASE_PRIORITIES.map(value => h('option', { key: value, value }, value.toUpperCase()))),
            h(TextField, {
              className: 'ds-input', style: { flex: 1, minWidth: 200 }, value: newCase.preconditions ?? '', placeholder: '前置条件，例如 会员等级≥银卡、账户余额充足',
              onChange: event => setNewCase({ ...newCase, preconditions: event.target.value }),
            }),
          ),
          h('div', { className: 'ds-field' },
            h('label', {}, '测试步骤（可选，一行一步）'),
            h(TextAreaField, {
              className: 'ds-input', rows: 2, value: newCase.stepsText ?? '',
              placeholder: '1. 打开积分抵扣页\n2. 选择「抵扣 10 元」\n3. 提交订单',
              onChange: event => setNewCase({ ...newCase, stepsText: event.target.value }),
            }),
          ),
          h('div', { className: 'ds-field' },
            h('label', {}, '多步接口（可选，一行一步：METHOD url | 期望状态码 | 提取变量）'),
            h(TextAreaField, {
              className: 'ds-input', rows: 3, value: newCase.steps,
              placeholder: 'POST /api/auth/login | 200 | data.token\nGET /api/points | 200 |',
              onChange: event => setNewCase({ ...newCase, steps: event.target.value }),
            }),
            h('div', { className: 'ds-hint' }, '先登录取 token、再带 token 调业务接口时用；变量写成 {{data.token}} 放进 url 或 body。第一步失败后面不会跑。'),
          ),
        ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('overview') },
        h('div', { className: 'ds-sec-head' }, '其它信息'),
      h('dl', { className: 'ds-kv' },
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
        h('dt', {}, '状态历史'), h('dd', {}, task.history.map(item => {
          const label = (state.statuses ?? []).find(entry => entry.id === item.status)?.label ?? item.status
          const tail = item.note === undefined || item.note === '' ? '' : `（${item.note}）`
          return `${label} · ${fmtTime(item.at)}${tail}`
        }).join(' → ') || '无'),
      ),
      ),
      h('div', { className: 'ds-sec', style: hideWhen('discuss') },
        h('div', { className: 'ds-sec-head' }, `评论（${task.comments.length}）`, h('span', { className: 'ds-hint' }, '最新的在最上面')),
        task.comments.length === 0
          ? h('div', { className: 'ds-empty' }, '还没有评论。在下面输入，或用 @专家名 直接点名派活。')
          : h('div', { className: 'ds-comments' },
            task.comments.slice().reverse().map(item => {
              const experts = state.config?.experts ?? []
              const expert = experts.find(entry => entry.name === item.author)
                ?? experts.find(entry => item.author !== undefined && item.author !== ''
                  && (entry.name.includes(item.author) || item.author.includes(entry.name)))
                ?? experts.find(entry => item.author === (ROLE_LABEL[entry.role] ?? ''))
              // 没写 kind 的历史评论：作者对不上任何专家、也不像角色名，就按「人」处理，
              // 避免人也画出机器人头像。
              const looksAi = /产品|架构|研发|开发|测试|运维|专家/.test(String(item.author ?? ''))
              const human = item.kind === 'human' ? true : item.kind === 'agent' ? false : !(expert !== undefined || looksAi)
              const who = human
                ? (item.author === undefined || item.author === '' || item.author === '人' ? '我' : item.author)
                : (expert?.name ?? (item.author === '' || item.author === undefined ? 'AI' : item.author))
              // 老评论的作者可能是「架构」「研发」这类简写，或带 emoji 前缀；
              // 能对上专家就统一显示专家本名，对不上原样显示。
              const bodyNodes = renderMarkdown(item.body)
              return h('div', {
                className: 'ds-cm', key: item.id,
                'data-kind': human ? 'human' : 'agent',
                'data-role': expert?.role ?? '',
              },
                h('div', { className: 'ds-cm-avatar' },
                  human ? h('span', { className: 'ds-cm-initial' }, who.slice(0, 1)) : (expert?.emoji ?? '🤖')),
                h('div', { className: 'ds-cm-main' },
                  h('div', { className: 'ds-cm-head' },
                    h('span', { className: 'ds-cm-name' }, who),
                    h('span', { className: 'ds-cm-kind' }, human ? '我提出' : 'AI 回复'),
                    expert !== undefined && expert.domain !== '' ? h(ChipField, { className: 'ds-chip', 'data-role': expert.role }, expert.domain) : null,
                    h('span', { className: 'ds-cm-meta' }, fmtTime(item.at)),
                  ),
                  h('div', { className: 'ds-cm-bubble ds-md' },
                    bodyNodes.length === 0 ? h('span', { className: 'ds-hint' }, '（这条评论没有正文）') : bodyNodes),
                ),
              )
            }),
          ),
      ),
        ),
      ),
      ),
      h('div', { className: 'ds-dw-foot' },
        h('div', { className: 'ds-mention-bar' },
          h('button', {
            className: 'ds-btn', disabled: busy,
            onClick: () => { setActive(0); setPicker(current => (current === null || current.inline) ? { query: '', from: null, inline: false } : null) },
          }, picker === null ? `@ 提到谁（${roster.length}）` : '收起名单'),
          h('span', { className: 'ds-hint' }, '也可以在输入框里直接打「@」搜'),
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
        h('div', { className: 'ds-composer' },
        h(TextAreaField, {
          className: 'ds-textarea',
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
        h('div', { className: 'ds-composer-bar' },
          h('span', { className: 'ds-hint' }, 'Markdown 可用 · 打 @ 派活 · Ctrl/⌘+Enter 发送'),
          h('span', { className: 'ds-composer-count' }, comment.trim() === '' ? '还没写' : `${comment.length} 字`),
          h('button', { className: 'ds-btn ds-btn-primary', disabled: busy || comment.trim() === '', onClick: () => void send() }, busy ? '发送中…' : '发表评论'),
        ),
        notice !== null ? h('span', { className: 'ds-ok' }, notice) : null,
        error !== null ? h('span', { className: 'ds-err' }, error) : null,
        ),
      ),
    ),
  )
}

  return Drawer
}
