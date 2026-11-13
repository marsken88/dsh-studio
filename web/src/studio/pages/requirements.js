/* Page-level components lifted out of client.src.js; shared handles come from the studio context. */

import { fmtTime, fmtDate } from '../format.js'
import { client } from '../context.js'
import { REQ_STATUS_LABEL, REQ_STATUS_ORDER, DOC_KIND_LABEL, DOC_KIND_ORDER, DOC_STATUS_LABEL } from '../labels.js'
import { caseSummaryOf, checkSummaryOf } from '../roster.js'

export     function IntakePage({ state, onChanged, mode }) {
  const { h, React, api, toast, currentUser, confirmDialog, promptDialog, renderMarkdown, TextField, TextAreaField, ChipField, CheckField, SelectField, MdField } = client()
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
      const panel = (title, hint, body) => h('div', { 'data-panel': title === '业务提单' ? 'form' : (title.startsWith('业务提单 ') ? 'list' : 'status'), style: { border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card)', display: 'flex', flexDirection: 'column', minWidth: 0 } },
        h('div', { style: { padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, title),
          h('span', { style: { fontSize: 11.5, color: 'var(--muted-foreground)' } }, hint),
        ),
        h('div', { style: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } }, body),
      )
      return h('div', { className: 'ds-body', 'data-mode': mode ?? '', style: { overflowY: 'auto' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,.85fr)', gap: 12, padding: '14px 16px 20px', alignItems: 'start' } },
          panel('业务提单', '提交后进入「草稿」，等产品补 PRD', [
            h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '标题'), h(TextField, { id: 'ip-title', placeholder: '一句话说清要做什么' })),
            h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '描述（至少 10 字）'), h(TextAreaField, { id: 'ip-desc', rows: 4, placeholder: '现状、期望、影响范围' })),
h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '项目'), h('select', { id: 'ip-project', className: 'ds-input' }, h('option', { value: '' }, '不指定（先进需求池）'), ((state.config && state.config.projects) || state.projects || []).map(item => h('option', { key: item.id, value: item.id }, item.name)))),
h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '迭代'), h(TextField, { id: 'ip-iteration', placeholder: '如 2026-11' })),
),
h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '优先级'), h('select', { id: 'ip-priority', className: 'ds-input' }, h('option', { value: 'normal' }, '普通'), h('option', { value: 'urgent' }, '紧急'), h('option', { value: 'relaxed' }, '不急'))),
h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, 'PRD 链接'), h(TextField, { id: 'ip-prd', placeholder: 'https://…' })),
h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '原型链接'), h(TextField, { id: 'ip-proto', placeholder: 'https://…' })),
h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '验收标准链接'), h(TextField, { id: 'ip-acceptance', placeholder: 'https://…' })),
            h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
              h('div', { className: 'ds-field', style: { flex: '1 1 140px' } }, h('div', { className: 'ds-label' }, '姓名'), h(TextField, { id: 'ip-name' })),
              h('div', { className: 'ds-field', style: { flex: '1 1 140px' } }, h('div', { className: 'ds-label' }, '部门'), h(TextField, { id: 'ip-dept' })),
              h('div', { className: 'ds-field', style: { flex: '1 1 140px' } }, h('div', { className: 'ds-label' }, '联系方式'), h(TextField, { id: 'ip-contact' })),
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: submit }, busy ? '提交中…' : '提交需求'),
              note === '' ? null : h('span', { style: { fontSize: 12, color: 'var(--muted-foreground)' } }, note),
            ),
          ]),
          panel('查进度', '编号 + 联系方式后四位', [
            h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '需求编号'), h(TextField, { id: 'ip-qcode', placeholder: 'REQ-2026-001' })),
            h('div', { className: 'ds-field' }, h('div', { className: 'ds-label' }, '联系方式后四位'), h(TextField, { id: 'ip-qcc' })),
            h('div', null, h('button', { className: 'ds-btn', onClick: query }, '查询')),
            result === '' ? null : h('div', { style: { padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--muted)', fontSize: 12, lineHeight: 1.6 } }, result),
          ]),
          h('div', { style: { gridColumn: '1 / -1' } },
            panel('业务提单 ' + business.length + ' 条', '转产品 = 送进待评审；产品补 PRD 后才能拆卡', [
              business.length === 0
                ? h('div', { className: 'ds-empty' }, '还没有业务提单。')
                : business.map(item => h('div', { key: item.id, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card)' } },
                  h('div', { style: { minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 2 } },
                    h('div', { style: { fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (item.code || '未编号') + '　' + item.title),
                    h('div', { style: { fontSize: 11.5, color: 'var(--muted-foreground)' } }, (REQ_STATUS_LABEL[item.status] ?? item.status) + ' · ' + (item.requester?.name ?? '') + (item.requester?.dept ? '（' + item.requester.dept + '）' : '')),
                  ),
                  h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => convert(item.id) }, '转产品'),
                )),
            ]),
          ),
        ),
      )
    }

export     function RequirementsPage({ state, onOpenTask, onChanged, createSignal, focusReq }) {
  const { h, React, api, toast, currentUser, confirmDialog, promptDialog, renderMarkdown, TextField, TextAreaField, ChipField, CheckField, SelectField, MdField } = client()
      const requirements = state.requirements ?? []
      const projects = state.config.projects ?? []
      const [selected, setSelected] = React.useState(requirements.length > 0 ? requirements[0].id : null)
      // 从顶部「＋ 新建 → 新建需求」进来时，展开新建表单（form 为 null 时不显示面板）。
      const openNew = () => {
        setForm({ title: '', description: '', project: '', iteration: '', owner: '', priority: 'normal', status: 'draft', links: {} })
        setError(null)
      }
      React.useEffect(() => { if (Number(createSignal) > 0) openNew() }, [createSignal])
      // 从全局搜索跳过来时，直接选中那一条需求。
      React.useEffect(() => { if (focusReq && focusReq.id) setSelected(focusReq.id) }, [focusReq])
      const [form, setForm] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [docForm, setDocForm] = React.useState(null)
      const [docNote, setDocNote] = React.useState(null)
      const [docReader, setDocReader] = React.useState(null)
      const [docAll, setDocAll] = React.useState(null)
      const [docBusy, setDocBusy] = React.useState(false)
      const [driveNote, setDriveNote] = React.useState(null)
      const [driveBusy, setDriveBusy] = React.useState(false)
      // ---- 功能点与可追溯矩阵：需求结构化之后，能查到「每条验收标准被谁做、被哪条用例验」
      const [matrix, setMatrix] = React.useState(null)
      const [matrixNote, setMatrixNote] = React.useState(null)
      const [pointForm, setPointForm] = React.useState(null)
      // ---- 需求准出与验收签字
      const [reqSign, setReqSign] = React.useState('')
      const [reqNote, setReqNote] = React.useState(null)
      // ---- 依赖与排序
      const [reqOrder, setReqOrder] = React.useState('0')
      const [reqDeps, setReqDeps] = React.useState([])
      const [depNote, setDepNote] = React.useState(null)

      const currentForDeps = requirements.find(item => item.id === selected) ?? null
      React.useEffect(() => {
        setReqOrder(String(currentForDeps?.order ?? 0))
        setReqDeps(Array.isArray(currentForDeps?.dependsOn) ? currentForDeps.dependsOn : [])
        setDepNote(null)
      }, [selected, currentForDeps?.updatedAt])

      const saveDeps = async () => {
        if (currentForDeps === null) return
        try {
          await api('/requirement/save', {
            requirement: {
              id: currentForDeps.id,
              title: currentForDeps.title,
              description: currentForDeps.description ?? '',
              project: currentForDeps.project ?? '',
              iteration: currentForDeps.iteration ?? '',
              owner: currentForDeps.owner ?? '',
              priority: currentForDeps.priority ?? 'normal',
              status: currentForDeps.status ?? 'draft',
              links: currentForDeps.links ?? {},
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
      const tasksOf = id => state.tasks.filter(task => task.requirementId === id)
      const statusLabel = id => (state.statuses.find(column => column.id === id)?.label ?? id)

      React.useEffect(() => {
        setMatrix(null)
        setMatrixNote(null)
        if (current !== null) void loadMatrix(current.id)
      }, [current === null ? '' : current.id, loadMatrix])

      const save = async () => {
        if (form === null) return
        if (String(form.title ?? '').trim() === '') { setError('需求标题不能为空'); return }
        setBusy(true)
        try {
          const payload = await api('/requirement/save', {
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
            },
          })
          setSelected(payload.requirement.id)
          setForm(null)
          setError(null)
          toast(payload.created === true ? '需求已创建' : '需求已保存')
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
          setSplitNote(created.length === 0
            ? '没有可拆的功能点：要么都覆盖了，要么还没加功能点。'
            : `已建 ${created.length} 张卡：${created.map(item => item.code || item.id).join('、')}`)
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

      const formPanel = form === null ? null : h('div', { className: 'ds-panel ds-form-panel' },
        h('div', { className: 'ds-panel-head' }, form.id === undefined ? '新建需求' : `编辑 ${current?.code ?? ''}`),
        h('div', { className: 'ds-panel-body' },
          h('div', { className: 'ds-field' },
            h('div', { className: 'ds-label' }, '需求标题'),
            h(TextField, { className: 'ds-input', value: form.title, onChange: e => setForm({ ...form, title: e.target.value }) }),
          ),
          h('div', { className: 'ds-row' },
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '业务项目'),
              h(SelectField, { className: 'ds-select', value: form.project, onChange: e => setForm({ ...form, project: e.target.value }) },
                h('option', { value: '' }, '不指定'),
                projects.map(project => h('option', { key: project.id, value: project.id }, project.name)),
              ),
            ),
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '状态'),
              h(SelectField, { className: 'ds-select', value: form.status, onChange: e => setForm({ ...form, status: e.target.value }) },
                REQ_STATUS_ORDER.map(id => h('option', { key: id, value: id }, REQ_STATUS_LABEL[id])),
              ),
            ),
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '业务负责人'),
              h(TextField, { className: 'ds-input', value: form.owner, onChange: e => setForm({ ...form, owner: e.target.value }) }),
            ),
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '业务领域'),
              h(TextField, { className: 'ds-input', placeholder: '支付 / 风控 / 会员（决定派给哪位领域专家）', value: form.domain ?? '', onChange: e => setForm({ ...form, domain: e.target.value }) }),
            ),
          ),
          h('div', { className: 'ds-field' },
            h('div', { className: 'ds-label' }, 'PRD 链接'),
            h(TextField, { className: 'ds-input', placeholder: 'https://…（飞书云文档）', value: form.prd, onChange: e => setForm({ ...form, prd: e.target.value }) }),
          ),
          h('div', { className: 'ds-row' },
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '原型链接'),
              h(TextField, { className: 'ds-input', value: form.proto, onChange: e => setForm({ ...form, proto: e.target.value }) }),
            ),
            h('div', { className: 'ds-field', style: { flex: 1 } },
              h('div', { className: 'ds-label' }, '验收标准链接'),
              h(TextField, { className: 'ds-input', value: form.acceptance, onChange: e => setForm({ ...form, acceptance: e.target.value }) }),
            ),
          ),
          h('div', { className: 'ds-field' },
            h('div', { className: 'ds-label' }, '需求正文 / PRD 摘要'),
            h(MdField, {
              className: 'ds-textarea',
              rows: 10,
              style: { minHeight: 180 },
              placeholder: '支持 Markdown：`# 背景`、`- 列表`、`**重点**`、`` `代码` ``、`| 表格 |`；保存后在「需求明细」里按 Markdown 渲染，不再截断。',
              value: form.description,
              onChange: e => setForm({ ...form, description: e.target.value }),
            }),
          ),
          h('div', { className: 'ds-row', style: { justifyContent: 'flex-end', gap: 8 } },
            h('button', { className: 'ds-btn', onClick: () => { setForm(null); setError(null) } }, '取消'),
            h('button', { className: 'ds-btn ds-btn-primary', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存需求'),
          ),
        ),
      )

      const detail = current === null ? h('div', { className: 'ds-empty' }, '左边选一条需求，或先新建一条。') : (() => {
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
        const link = (label, url) => url === '' ? null : h('a', { className: 'ds-link', href: url, target: '_blank', rel: 'noreferrer' }, label)
        return h('div', { className: 'ds-req-body' },
          h('div', { className: 'ds-req-headline' },
            h('div', null,
              h('div', { className: 'ds-req-code' }, current.code || current.id),
              h('div', { className: 'ds-req-name' }, current.title),
            ),
            h('div', { className: 'ds-req-actions' },
              h(SelectField, { className: 'ds-select', value: current.status, onChange: e => void setStatus(e.target.value) },
                REQ_STATUS_ORDER.map(id => h('option', { key: id, value: id }, REQ_STATUS_LABEL[id])),
              ),
              h('button', { className: 'ds-btn', onClick: () => setForm({ ...current, ...links }) }, '编辑'),
              h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void remove(current.id), 'data-danger': '1' }, '删除'),
            ),
          ),
          (() => {
            // 评审：草稿要先过评审才能拆卡；打回会退回草稿并留意见。
            const review = current.review ?? null
            const stateLabel = review === null ? '还没提交评审' : (REVIEW_LABEL[review.status] ?? review.status)
            const canSubmit = review === null || review.status === 'changes_requested'
            const canDecide = review !== null && review.status === 'pending'
            return h('div', { className: 'ds-panel', 'data-review': review === null ? 'none' : review.status, style: { marginTop: 14 } },
              h('div', { className: 'ds-panel-head' },
                h('span', null, '需求评审'),
                h(ChipField, { className: 'ds-chip', 'data-on': review?.status === 'approved' ? '1' : '0', style: { marginLeft: 8 } }, stateLabel),
                review === null || review.at === 0 ? null : h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, `${fmtTime(review.at)}${review.by === '' ? '' : ` · ${review.by}`}`),
              ),
              h('div', { className: 'ds-panel-body' },
                review !== null && String(review.note ?? '') !== ''
                  ? h('div', { className: 'ds-hint', style: { marginBottom: 8 } }, `评审意见：${review.note}`)
                  : null,
                h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 8 } },
                  canSubmit ? h('button', { className: 'ds-btn ds-btn-primary', disabled: reviewBusy, onClick: () => void reviewRequirement('submit') }, reviewBusy ? '提交中…' : '提交评审') : null,
                  canDecide ? h('button', { className: 'ds-btn ds-btn-primary', disabled: reviewBusy, onClick: () => void reviewRequirement('approve') }, '评审通过') : null,
                  canDecide ? h('button', { className: 'ds-btn ds-btn-ghost', disabled: reviewBusy, onClick: rejectReview, 'data-danger': '1' }, '打回') : null,
                  review?.status === 'approved' ? h('span', { className: 'ds-hint' }, '评审已通过，可以拆卡和派活了。') : null,
                ),
                reviewNote === null ? null : h('div', { className: 'ds-hint', style: { marginTop: 8 } }, reviewNote),
              ),
            )
          })(),
          (link('PRD', links.prd) || link('原型', links.proto) || link('验收标准', links.acceptance))
            ? h('div', { className: 'ds-req-links' }, link('PRD 文档', links.prd), link('原型', links.proto), link('验收标准', links.acceptance))
            : h('div', { className: 'ds-empty' }, [h('span', null, '还没有登记 PRD / 原型 / 验收标准链接；PRD 与原型由产品在澄清后输出，可在这里补，或点右边「让产品补 PRD」。'), h('button', { className: 'ds-btn ds-btn-ghost', style: { marginLeft: 8 }, onClick: async () => { const note = await promptDialog('想请产品补什么？', { title: '申请产品补 PRD', defaultValue: '需要产品输出 PRD 与原型' }); if (note === null) return; try { await api('/requirement/request-prd', { id: current.id, by: currentUser(), note }); toast('已申请产品补 PRD'); onChanged() } catch (error) { toast(error.message ?? String(error), 'error') } } }, '让产品补 PRD')]),
          current.description
            ? h('div', { className: 'ds-panel ds-req-desc-panel', style: { marginTop: 14 } },
              h('div', { className: 'ds-panel-head' },
                h('span', null, '需求明细'), current.source === 'business' ? h('span', { className: 'ds-hint', 'data-src': 'business' }, `业务提单 · ${current.requester?.name || '未署名'}${current.requester?.dept ? '（' + current.requester.dept + '）' : ''} · ${fmtTime(current.requester?.at || current.createdAt)}`) : null,
                h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, '支持 Markdown'),
              ),
              h('div', { className: 'ds-panel-body' },
                h('div', { className: 'ds-req-desc ds-md' }, renderMarkdown(current.description)),
              ),
            )
            : h('div', { className: 'ds-req-desc ds-hint' }, '还没有写需求描述：产品背景、要解决的问题、验收口径都建议写在这里，点右侧「编辑」补上。'),
(() => {
            // 变更记录：字段级 diff，谁在什么时候把标题/正文/优先级/状态/负责人/项目/迭代改了。
            const history = (current.history ?? []).slice().reverse()
            if (history.length === 0 || (current.change ?? null) !== null) return null
            const label = { title: '标题', description: '需求明细', priority: '优先级', status: '状态', owner: '负责人', project: '项目', iteration: '迭代' }
            return h('div', { className: 'ds-panel ds-history-panel', style: { marginTop: 14 } },
              h('div', { className: 'ds-panel-head' },
                h('span', null, '变更记录'),
                h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, `最近 ${history.length} 条`),
              ),
              h('div', { className: 'ds-panel-body' },
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' } },
                  history.map((item, index) => h('div', { key: `${item.at}-${index}`, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 } },
                    h('span', { className: 'ds-hint', style: { flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, fmtTime(item.at)),
                    h('span', { style: { flex: '0 0 auto' } }, item.by === '' ? '人' : item.by),
                    h('span', { className: 'ds-chip', style: { flex: '0 0 auto' } }, label[item.field] ?? item.field),
                    h('span', { className: 'ds-hint', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
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
            return h('div', { className: 'ds-panel ds-pool-panel', style: { marginTop: 14 } },
              h('div', { className: 'ds-panel-head' },
                h('span', null, '需求池评分（RICE）'),
                h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, pool.score > 0 ? `得分 ${pool.score}` : '还没打分：不打分就没法和别的需求比优先级'),
                h('button', { className: 'ds-btn ds-btn-ghost', style: { marginLeft: 8 }, onClick: () => void score() }, pool.score > 0 ? '重新打分' : '打分'),
              ),
              pool.score > 0 ? h('div', { className: 'ds-panel-body' }, h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 8 } },
                h('span', { className: 'ds-chip' }, `影响面 ${pool.reach}`),
                h('span', { className: 'ds-chip' }, `影响度 ${pool.impact}`),
                h('span', { className: 'ds-chip' }, `置信度 ${pool.confidence}%`),
                h('span', { className: 'ds-chip' }, `成本 ${pool.effort} 人日`),
                h('span', { className: 'ds-chip', 'data-on': '1' }, `得分 ${pool.score}`),
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
            return h('div', { className: 'ds-panel ds-question-panel', 'data-open': openCount > 0 ? '1' : '0', style: { marginTop: 14 } },
              h('div', { className: 'ds-panel-head' },
                h('span', null, '待确认清单'),
                h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, openCount > 0 ? `${openCount} 个没回答，回答完才能拆卡` : (questions.length === 0 ? '澄清阶段把不确定的先记在这里' : '全部已回答')),
                h('button', { className: 'ds-btn ds-btn-ghost', style: { marginLeft: 8 }, onClick: () => void addQuestion() }, '＋ 加问题'),
              ),
              h('div', { className: 'ds-panel-body' },
                questions.length === 0
                  ? h('div', { className: 'ds-empty' }, '还没有待确认的问题。产品澄清时把「需要业务拍板」的点写在这里，避免猜业务规则。')
                  : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, questions.map(item => h('div', {
                    key: item.id,
                    className: 'ds-question-row',
                    'data-status': item.status,
                    style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card)' },
                  },
                    h('span', { className: 'ds-chip', 'data-on': item.status === 'answered' ? '1' : '0' }, item.status === 'answered' ? '已回答' : '待回答'),
                    h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                      h('div', { style: { fontSize: 13 } }, item.text),
                      item.answer === '' || item.answer === undefined ? null : h('div', { className: 'ds-hint', style: { marginTop: 4 } }, `答：${item.answer}`),
                    ),
                    h('div', { style: { display: 'flex', gap: 6, flex: '0 0 auto' } },
                      h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void answerQuestion(item) }, item.status === 'answered' ? '改答案' : '回答'),
                      h('button', { className: 'ds-btn ds-btn-ghost', 'data-danger': '1', onClick: () => void removeQuestion(item) }, '删除'),
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
            const byId = new Map(tasks.map(task => [task.id, task]))
            const statusLabel = id => (state.statuses.find(entry => entry.id === id)?.label) ?? id
            return h('div', { className: 'ds-panel ds-change-panel', 'data-invalidated': change.invalidated ? '1' : '0', style: { marginTop: 14 } },
              h('div', { className: 'ds-panel-head' },
                h('span', null, change.invalidated ? '变更影响（签字已作废）' : '变更影响'),
                h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } },
                  `${fmtTime(change.at)}${change.by === '' ? '' : ` · ${change.by}`}`),
              ),
              h('div', { className: 'ds-panel-body' },
                (function () {
                  const rows = (current.history ?? []).slice().reverse()
                  if (rows.length === 0) return null
                  const label = { title: '标题', description: '需求明细', priority: '优先级', status: '状态', owner: '负责人', project: '项目', iteration: '迭代' }
                  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto', marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed var(--border)' } },
                    h('div', { className: 'ds-hint', style: { fontWeight: 600 } }, `变更记录 · 最近 ${rows.length} 条`),
                    rows.map((item, index) => h('div', { key: `${item.at}-${index}`, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 } },
                      h('span', { className: 'ds-hint' }, fmtTime(item.at)),
                      h('span', null, item.by === '' ? '人' : item.by),
                      h('span', { className: 'ds-chip' }, label[item.field] ?? item.field),
                      h('span', { className: 'ds-hint' }, `${item.from === '' ? '（空）' : item.from} → ${item.to === '' ? '（空）' : item.to}`),
                    )),
                  )
                })(),
                h('div', { className: 'ds-hint' },
                  `改了：${(change.parts ?? []).join('、')}。${affected.length === 0
                    ? '当时没有已产出的卡受影响，不用返工。'
                    : `${affected.length} 张卡已经产出过东西，要按新版复核：`}`),
                affected.length === 0 ? null : h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 8, marginTop: 8 } },
                  affected.map(item => h('span', {
                    key: item.id,
                    className: 'ds-chip',
                    'data-pt': 'open',
                    style: { cursor: 'pointer' },
                    title: item.title,
                    onClick: () => {
                      const task = byId.get(item.id)
                      if (task !== undefined && typeof onOpenTask === 'function') onOpenTask(task)
                    },
                  }, `${item.code || item.id} ${statusLabel(item.status)}`)),
                ),
                change.invalidated ? h('div', { className: 'ds-hint', style: { marginTop: 8 } }, '验收签字已清空：这些卡是按旧版做的，复核完重新签一次。') : null,
              ),
            )
          })(),
          // 上线足迹：这条需求对应的版本上过哪些环境（部署记录是人工登记的，平台不触发部署）。
          (() => {
            const deploys = current.deploys ?? []
            if (deploys.length === 0) return null
            return h('div', { className: 'ds-panel', style: { marginTop: 14 } },
              h('div', { className: 'ds-panel-head' },
                h('span', null, '上线足迹'),
                h('span', { className: 'ds-hint', style: { marginLeft: 'auto' } }, '来自版本的部署记录，只留痕不触发'),
              ),
              h('div', { className: 'ds-panel-body' },
                h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 8 } },
                  deploys.map(item => h('span', {
                    key: item.id,
                    className: 'ds-chip',
                    'data-env': item.kind,
                    title: `${item.releaseName ?? ''} · ${fmtTime(item.at)} · ${item.by}`,
                  }, `${item.name} · ${fmtDate(item.at)}`)),
                ),
              ),
            )
          })(),
          h('div', { className: 'ds-panel', style: { marginTop: 14 } },
            h('div', { className: 'ds-panel-head' }, h('span', null, '依赖与排序')),
            h('div', { className: 'ds-panel-body' },
              h('div', { className: 'ds-row' },
                h('span', { className: 'ds-hint' }, '排序号'),
                h(TextField, { className: 'ds-input', style: { width: 90 }, value: reqOrder, onChange: e => setReqOrder(e.target.value) }),
                h('span', { className: 'ds-hint' }, '被依赖的需求没交付，这条需求的准出会被拦'),
              ),
              h('div', { className: 'ds-row', style: { flexWrap: 'wrap', gap: 10 } },
                requirements.filter(item => item.id !== current.id).map(item => h('label', { key: item.id, className: 'ds-check-row' },
                  h(CheckField, { checked: reqDeps.includes(item.id),
                    onChange: event => setReqDeps(done => event.target.checked ? [...done, item.id] : done.filter(id => id !== item.id)),
                  }),
                  h('span', { className: 'ds-check-text' }, `${item.code || item.id} ${item.title}（${REQ_STATUS_LABEL[item.status] ?? item.status}）`),
                )),
                requirements.length <= 1 ? h('span', { className: 'ds-hint' }, '只有这一条需求，暂时没有可依赖的对象。') : null,
              ),
              h('div', { className: 'ds-row' },
                h('button', { className: 'ds-btn ds-btn-primary', onClick: () => void saveDeps() }, '保存排序与依赖'),
                depNote === null ? null : h('span', { className: 'ds-hint' }, depNote),
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
            return h('div', { className: 'ds-panel', style: { marginTop: 14 } },
              h('div', { className: 'ds-panel-head' },
                h('span', null, '需求准出与验收签字'),
                h(ChipField, { className: 'ds-chip', 'data-pt': gate.ready ? 'covered' : 'open', style: { marginLeft: 'auto' } },
                  gate.ready ? '可以交付' : `还差 ${gate.blockers.length} 项`),
              ),
              h('div', { className: 'ds-panel-body' },
                h('div', { className: 'ds-check-progress' },
                  h('div', { className: 'ds-check-bar', 'data-full': pct === 100 ? '1' : '0' },
                    h('span', { style: { width: `${pct}%` } })),
                  h('div', { className: 'ds-hint' },
                    `${pct}% · ${done}/${tasks.length} 张卡完成 · 功能点覆盖 ${covered}/${pointTotal} · 用例通过 ${casePass}/${caseTotal}`),
                ),
                (gate.blockers ?? []).map(line => h('div', { key: line, className: 'ds-gate-item', 'data-kind': 'block' }, `⛔ ${line}`)),
                (gate.warnings ?? []).map(line => h('div', { key: line, className: 'ds-gate-item', 'data-kind': 'warn' }, `⚠ ${line}`)),
                gate.ready ? h('div', { className: 'ds-hint' }, '门禁已通过：签完字这条需求就算交付。') : null,
                signoff === null
                  ? h('div', { className: 'ds-gate-sign' },
                    h(TextField, {
                      className: 'ds-input', style: { flex: 1, minWidth: 220 },
                      placeholder: '验收结论：交付了什么、遗留什么',
                      value: reqSign, onChange: e => setReqSign(e.target.value),
                    }),
                    h('button', { className: 'ds-btn ds-btn-primary', onClick: () => void signRequirement('sign') }, '需求验收签字'),
                  )
                  : h('div', { className: 'ds-gate-sign' },
                    h('div', { className: 'ds-hint', style: { flex: 1 } }, `✍ ${signoff.by} 于 ${fmtTime(signoff.at)} 签字：${signoff.note}`),
                    h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void signRequirement('clear') }, '取消签字'),
                  ),
                reqNote === null ? null : h('div', { className: 'ds-hint' }, reqNote),
              ),
            )
          })(),
          h('div', { className: 'ds-sec-head', style: { marginTop: 16 } }, '交付物归档（飞书云盘）',
            h('div', { className: 'ds-req-actions' },
              folder.url ? h('a', { className: 'ds-link', href: folder.url, target: '_blank', rel: 'noreferrer' }, '打开文件夹') : null,
              h('button', { className: 'ds-btn ds-btn-ghost', disabled: driveBusy, onClick: () => void createFolder() }, folder.url ? '校验文件夹' : '创建文件夹'),
              h('button', {
                className: 'ds-btn', disabled: driveBusy || artifacts.length === 0,
                onClick: () => void syncReqArtifacts(),
              }, driveBusy ? '归档中…' : `归档 ${artifacts.length} 件交付物`),
            )),
          h('div', { className: 'ds-hint' }, folder.url
            ? `文件夹：${folder.name || folder.token}　已归档 ${artifacts.filter(item => item.doc?.url).length}/${artifacts.length} 件交付物`
            : (folder.error ? `上次创建失败：${folder.error}` : '还没有云盘文件夹；建好后，这条需求下每件交付物都会写成文件夹里的一份 Markdown 文档。')),
          driveNote ? h('div', { className: 'ds-hint' }, driveNote) : null,
          h('div', { className: 'ds-sec-head', style: { marginTop: 16 } }, '文档与基线',
            h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void openDoc(null) }, '＋ 添加文档'),
          ),
          current.baseline
            ? h('div', { className: 'ds-base-box' },
              h('div', { className: 'ds-base-main' },
                h('b', null, `当前基线 ${current.baseline.version}`),
                h('span', null, `${current.baseline.title} · 生效于 ${fmtTime(current.baseline.at)} · ${current.baseline.by || '人'} · 正文 ${current.baseline.contentLength ?? 0} 字`),
              ),
              h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void clearBaseline() }, '取消基线'),
            )
            : h('div', { className: 'ds-base-box', 'data-empty': '1' },
              h('div', { className: 'ds-base-main' },
                h('b', null, '还没有基线'),
                h('span', null, 'PRD 评审通过后点「设为基线」，之后建的卡都会记下用的是哪一版。'),
              ),
            ),
          (current.docs ?? []).length === 0
            ? h('div', { className: 'ds-hint', style: { marginTop: 8 } }, '还没有登记文档。可以先加 PRD 链接，把正文粘进来，评审通过后设为基线。')
            : h('div', null,
              h('div', { className: 'ds-row', style: { marginTop: 8, gap: 8, alignItems: 'center' } },
                h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void expandAllDocs() }, docAll === null ? '全部展开' : '全部收起'),
                h('span', { className: 'ds-hint' }, `共 ${(current.docs ?? []).length} 篇，展开后可直接读 Markdown 正文`)),
              h('div', { className: 'ds-doc-list' }, (current.docs ?? []).map(doc => h('div', { key: doc.id, className: 'ds-doc-wrap' }, h('div', { className: 'ds-doc-row' },
              h(ChipField, { className: 'ds-chip', 'data-doc': doc.kind }, DOC_KIND_LABEL[doc.kind] ?? doc.kind),
              h('div', { className: 'ds-doc-main' },
                h('div', { className: 'ds-doc-title' },
                  doc.url === '' ? doc.title : h('a', { className: 'ds-link', href: doc.url, target: '_blank', rel: 'noreferrer' }, doc.title),
                  h('span', { className: 'ds-chip-code' }, doc.version),
                  h(ChipField, { className: 'ds-chip', 'data-docstatus': doc.status }, DOC_STATUS_LABEL[doc.status] ?? doc.status),
                ),
                h('div', { className: 'ds-doc-meta' }, `正文 ${doc.contentLength ?? 0} 字 · ${doc.by || '—'} · ${doc.at > 0 ? fmtTime(doc.at) : '—'}`),
              ),
              h('div', { className: 'ds-listrow-actions' },
                doc.status === 'baseline' ? null : h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void baselineDoc(doc.id) }, '设为基线'),
                h('button', { className: 'ds-btn ds-btn-ghost', title: '直接读正文（Markdown 渲染）', onClick: () => void readDoc(doc.id) }, docReader !== null && docReader.id === doc.id ? '收起' : '阅读'),
                h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void openDoc(doc.id) }, '编辑'),
                h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void removeDoc(doc.id), 'data-danger': '1' }, '删除'),
              ),
            ),
            docReader !== null && docReader.id === doc.id
              ? h('div', { className: 'ds-md-preview ds-reader' }, docReader.busy
                ? h('span', { className: 'ds-hint' }, '读取中…')
                : (docReader.content.trim() === '' ? h('span', { className: 'ds-hint' }, '这条文档还没有正文。') : renderMarkdown(docReader.content)))
              : (docAll !== null && docAll[doc.id] !== undefined
                ? h('div', { className: 'ds-md-preview ds-reader' }, docAll[doc.id].trim() === ''
                  ? h('span', { className: 'ds-hint' }, '这条文档还没有正文。')
                  : renderMarkdown(docAll[doc.id]))
                : null),
            )))),
          docNote === null ? null : h('div', { className: 'ds-hint', style: { marginTop: 6 } }, docNote),
          docForm === null ? null : h('div', { className: 'ds-panel ds-form-panel', style: { marginTop: 10 } },
            h('div', { className: 'ds-panel-head' }, docForm.id === undefined ? '添加文档' : `编辑 ${docForm.title}`),
            h('div', { className: 'ds-panel-body' },
              h('div', { className: 'ds-row', style: { gap: 10 } },
                h('div', { className: 'ds-field', style: { flex: '0 0 150px' } },
                  h('div', { className: 'ds-label' }, '类型'),
                  h(SelectField, { className: 'ds-select', value: docForm.kind, onChange: e => setDocForm({ ...docForm, kind: e.target.value }) },
                    DOC_KIND_ORDER.map(id => h('option', { key: id, value: id }, DOC_KIND_LABEL[id]))),
                ),
                h('div', { className: 'ds-field', style: { flex: '1 1 220px' } },
                  h('div', { className: 'ds-label' }, '标题'),
                  h(TextField, { className: 'ds-input', value: docForm.title, placeholder: '例如 会员积分抵扣 PRD', onChange: e => setDocForm({ ...docForm, title: e.target.value }) }),
                ),
                h('div', { className: 'ds-field', style: { flex: '0 0 110px' } },
                  h('div', { className: 'ds-label' }, '版本'),
                  h(TextField, { className: 'ds-input', value: docForm.version, placeholder: 'v1.0', onChange: e => setDocForm({ ...docForm, version: e.target.value }) }),
                ),
              ),
              h('div', { className: 'ds-row', style: { gap: 10 } },
                h('div', { className: 'ds-field', style: { flex: '1 1 auto' } },
                  h('div', { className: 'ds-label' }, '飞书文档链接'),
                  h(TextField, { className: 'ds-input', value: docForm.url, placeholder: 'https://laiyifen.feishu.cn/wiki/…', onChange: e => setDocForm({ ...docForm, url: e.target.value }) }),
                ),
                h('div', { className: 'ds-field', style: { flex: '0 0 auto', justifyContent: 'flex-end' } },
                  h('div', { className: 'ds-label' }, ' '),
                  h('button', { className: 'ds-btn', disabled: docBusy, onClick: () => void pullDoc() }, docBusy ? '拉取中…' : '从链接拉正文'),
                ),
              ),
              h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '文档正文（拉不到就自己粘，研发和测试都读这一份）'),
                h(MdField, { className: 'ds-textarea', rows: 8, value: docForm.content, onChange: e => setDocForm({ ...docForm, content: e.target.value }) }),
              ),
              h('div', { className: 'ds-row', style: { justifyContent: 'flex-end', gap: 8 } },
                h('button', { className: 'ds-btn', onClick: () => { setDocForm(null); setDocNote(null) } }, '取消'),
                h('button', { className: 'ds-btn ds-btn-primary', disabled: docBusy, onClick: () => void saveDoc() }, '保存文档'),
              ),
            ),
          ),
          h('div', { className: 'ds-pane-head', style: { marginTop: 16 } },
            h('div', { className: 'ds-pane-title' }, '功能点与可追溯矩阵'),
            h('div', { className: 'ds-pane-desc' }, '功能点是需求的骨架：一条功能点对若干张卡、若干条用例。卡和用例上都挂 pointId，这里就能看出哪条没人做、哪条没被验证。'),
          ),
          matrix === null
            ? h('div', { className: 'ds-hint', style: { padding: '6px 0' } }, '还没有功能点。点「＋ 加功能点」把需求拆成可交付、可验证的条目。')
            : h('div', { className: 'ds-matrix' },
              h('div', { className: 'ds-matrix-sum' },
                `功能点 ${matrix.summary.points} · 已覆盖 ${matrix.summary.coveredPoints}${matrix.summary.pointsWithoutCases > 0 ? `（${matrix.summary.pointsWithoutCases} 条还没有用例，覆盖率 ${matrix.summary.coverageRate}%）` : ''} · 卡 ${matrix.summary.cards}（未归点 ${matrix.summary.looseCards}）· 用例 ${matrix.summary.cases}（通过 ${matrix.summary.pass}${matrix.summary.fail > 0 ? `，失败 ${matrix.summary.fail}` : ''}）· 通过率 ${matrix.summary.passRate}%`,
              ),
              (matrix.points ?? []).map(point => h('div', { key: point.id, className: 'ds-pt-row', 'data-covered': point.covered ? '1' : '0' },
                h('div', { className: 'ds-pt-main' },
                  h('div', { className: 'ds-pt-title' },
                    h('span', { className: 'ds-chip-code' }, point.id),
                    h('b', null, point.title),
                    h(ChipField, { className: 'ds-chip', 'data-pt': point.covered ? 'covered' : 'open' }, point.covered ? '已覆盖' : '未覆盖'),
                  ),
                  String(point.description ?? '') === '' ? null : h('div', { className: 'ds-req-desc ds-md' }, renderMarkdown(point.description)),
                  h('div', { className: 'ds-pt-meta' },
                    `卡 ${point.cards.length}${point.cards.length === 0 ? '（还没人做）' : '：' + point.cards.map(card => card.code || card.id).join('、')}`,
                    ` · 用例 ${point.cases.total}（通过 ${point.cases.pass}${point.cases.fail > 0 ? `，失败 ${point.cases.fail}` : ''}${point.cases.pending > 0 ? `，没跑 ${point.cases.pending}` : ''}）`,
                    point.acceptance.length === 0 ? '' : ` · 验收条件 ${point.acceptance.filter(item => item.covered).length}/${point.acceptance.length}`,
                  ),
                ),
                h('div', { className: 'ds-listrow-actions' },
                  h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => setPointForm({ ...point, acceptanceText: (point.acceptance ?? []).map(item => item.text).join('\n') }) }, '编辑'),
                  h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => void removePoint(point.id), 'data-danger': '1' }, '删除'),
                ),
              )),
              (matrix.loose ?? []).length === 0 ? null : h('div', { className: 'ds-pt-loose' },
                h('div', { className: 'ds-hint', style: { marginBottom: 6 } }, `还有 ${matrix.loose.length} 张卡没归到功能点，选一个挂上去，矩阵才算完整：`),
                matrix.loose.map(card => h('div', { key: card.id, className: 'ds-pt-loose-row' },
                  h('span', { className: 'ds-chip-code' }, card.code || card.id),
                  h('span', { className: 'ds-pt-loose-title' }, card.title),
                  h(SelectField, {
                    className: 'ds-select',
                    style: { width: 220 },
                    value: '',
                    onChange: event => { if (event.target.value !== '') void assignLoose(card.id, event.target.value) },
                  },
                    h('option', { value: '' }, '挂到…'),
                    (matrix.points ?? []).map(point => h('option', { key: point.id, value: point.id }, `${point.id} ${point.title}`)),
                  ),
                )),
              ),
            ),
          h('div', { className: 'ds-row', style: { gap: 8, marginTop: 10, alignItems: 'center' } },
            h('button', { className: 'ds-btn', onClick: () => setPointForm(blankPoint()) }, '＋ 加功能点'),
            h('button', { className: 'ds-btn ds-btn-primary', disabled: splitBusy, onClick: () => void splitPoints() }, splitBusy ? '拆卡中…' : '按未覆盖的功能点拆卡'),
            h('button', { className: 'ds-btn ds-btn-ghost', onClick: () => { if (current !== null) void loadMatrix(current.id) } }, '刷新矩阵'),
            splitNote === null ? null : h('span', { className: 'ds-hint' }, splitNote),
            matrixNote === null ? null : h('span', { className: 'ds-hint' }, matrixNote),
          ),
          pointForm === null ? null : h('div', { className: 'ds-panel ds-form-panel', style: { marginTop: 10 } },
            h('div', { className: 'ds-panel-head' }, pointForm.id === undefined ? '新增功能点' : `编辑功能点 ${pointForm.id}`),
            h('div', { className: 'ds-panel-body' },
              h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '功能点标题'),
                h(TextField, { className: 'ds-input', value: pointForm.title, placeholder: '例如 结算页展示可用积分', onChange: event => setPointForm({ ...pointForm, title: event.target.value }) }),
              ),
              h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '说明'),
                h(MdField, { className: 'ds-textarea', rows: 3, value: pointForm.description ?? '', onChange: event => setPointForm({ ...pointForm, description: event.target.value }) }),
              ),
              h('div', { className: 'ds-field' },
                h('div', { className: 'ds-label' }, '验收条件（一行一条，做成什么样算完成）'),
                h(TextAreaField, { className: 'ds-textarea', rows: 4, value: pointForm.acceptanceText ?? '', onChange: event => setPointForm({ ...pointForm, acceptanceText: event.target.value }) }),
              ),
              h('div', { className: 'ds-row', style: { gap: 10 } },
                h('div', { className: 'ds-field', style: { flex: '0 0 150px' } },
                  h('div', { className: 'ds-label' }, '优先级'),
                  h(SelectField, { className: 'ds-select', value: pointForm.priority, onChange: event => setPointForm({ ...pointForm, priority: event.target.value }) },
                    h('option', { value: 'urgent' }, '紧急'), h('option', { value: 'normal' }, '普通'), h('option', { value: 'relaxed' }, '可缓')),
                ),
                h('div', { className: 'ds-field', style: { flex: '0 0 150px' } },
                  h('div', { className: 'ds-label' }, '状态'),
                  h(SelectField, { className: 'ds-select', value: pointForm.status, onChange: event => setPointForm({ ...pointForm, status: event.target.value }) },
                    h('option', { value: 'draft' }, '草稿'), h('option', { value: 'ready' }, '就绪'), h('option', { value: 'done' }, '已完成')),
                ),
              ),
              h('div', { className: 'ds-row', style: { justifyContent: 'flex-end', gap: 8 } },
                h('button', { className: 'ds-btn', onClick: () => setPointForm(null) }, '取消'),
                h('button', { className: 'ds-btn ds-btn-primary', onClick: () => void savePoint() }, '保存功能点'),
              ),
            ),
          ),
          h('div', { className: 'ds-req-stats' },
            h('div', { className: 'ds-stat-box' }, h('b', null, `${done}/${tasks.length}`), h('span', null, '卡已完成')),
            h('div', { className: 'ds-stat-box', 'data-warn': blocked > 0 ? '1' : '0' }, h('b', null, String(blocked)), h('span', null, '阻塞')),
            h('div', { className: 'ds-stat-box', 'data-warn': bugs > 0 ? '1' : '0' }, h('b', null, String(bugs)), h('span', null, '未结缺陷')),
            h('div', { className: 'ds-stat-box' }, h('b', null, `${check.done}/${check.total}`), h('span', null, '验收清单')),
            h('div', { className: 'ds-stat-box' }, h('b', null, `${caseAgg.pass}/${caseAgg.total}`), h('span', null, '用例通过')),
            h('div', { className: 'ds-stat-box' }, h('b', null, String(artifacts.length)), h('span', null, '交付物')),
            h('div', { className: 'ds-stat-box' }, h('b', null, String(mrs.length)), h('span', null, 'MR')),
          ),
          h('div', { className: 'ds-sec-head', style: { marginTop: 14 } }, `这张需求下的 ${tasks.length} 张卡`),
          tasks.length === 0
            ? h('div', { className: 'ds-empty' }, '还没有挂上来的卡。建卡时选择这条需求，编号会自动分配。')
            : h('div', { className: 'ds-req-tasks' }, tasks.map(task => h('div', {
                key: task.id,
                className: 'ds-listrow ds-req-task',
                onClick: () => onOpenTask(task.id),
              },
                h('div', { className: 'ds-listrow-main' },
                  h('div', { className: 'ds-req-task-title' },
                    task.code ? h(ChipField, { className: 'ds-chip ds-chip-code' }, task.code) : null,
                    h('span', null, task.title),
                  ),
                  h('div', { className: 'ds-hint' }, `${statusLabel(task.status)}${(() => {
                    const name = task.expert === '' ? '' : ((state.config.experts ?? []).find(entry => entry.id === task.expert)?.name ?? task.expert)
                    return name === '' ? '' : ` · ${name}`
                  })()}${task.dueAt > 0 ? ` · 截止 ${fmtDate(task.dueAt)}` : ''}`),
                ),
                h('div', { className: 'ds-listrow-actions' },
                  task.blocked !== undefined && task.blocked !== null ? h(ChipField, { className: 'ds-chip ds-chip-blocked' }, '⛔') : null,
                  task.type === 'bug' ? h(ChipField, { className: 'ds-chip ds-chip-bug', 'data-sev': task.severity ?? 'p2' }, 'BUG') : null,
                ),
              ))),
          mrs.length > 0 ? h('div', null,
            h('div', { className: 'ds-sec-head', style: { marginTop: 14 } }, '关联 MR'),
            mrs.map(task => h('div', { key: task.id, className: 'ds-hint' }, `${task.code || task.id} · !${task.gitlabMR.iid} ${task.gitlabMR.title ?? ''}（${task.gitlabMR.state || 'open'}）`)),
          ) : null,
        )
      })()

return h('div', { className: 'ds-body' },
        error !== null ? h('div', { className: 'ds-err', style: { marginBottom: 10 } }, error) : null,
        formPanel,
        h('div', { className: 'ds-req-grid' },
          h('div', { className: 'ds-intake-launch', style: { display: 'flex', gap: 8, padding: '0 0 8px' } },
            h('span', { className: 'ds-hint' }, '新建需求请用右上角「＋ 新建」'),
          ),
          
          h('div', { className: 'ds-req-list' },
            h('div', { className: 'ds-req-list-head' },
              h('span', null, `需求 ${requirements.length}`),
              h('button', {
                className: 'ds-btn ds-btn-ghost',
                style: { marginLeft: 8 },
                title: '按来源筛选：全部 / 业务提单 / 内部',
                onClick: () => { const cur = window.localStorage.getItem('dsh-studio:reqsrc') ?? 'all'; window.localStorage.setItem('dsh-studio:reqsrc', cur === 'all' ? 'business' : cur === 'business' ? 'internal' : 'all'); window.dispatchEvent(new Event('resize')) },
              }, (window.localStorage.getItem('dsh-studio:reqsrc') ?? 'all') === 'all' ? '来源：全部' : (window.localStorage.getItem('dsh-studio:reqsrc') === 'business' ? '来源：业务提单' : '来源：内部')),
            ),
            requirements.length === 0
              ? h('div', { className: 'ds-empty' }, '还没有需求。先建一条——后面所有的卡、用例、缺陷、MR 都会挂在它下面。')
              : ((window.localStorage.getItem('dsh-studio:reqsort') ?? 'score') === 'score' ? requirements.slice().sort((left, right) => (right.pool?.score ?? 0) - (left.pool?.score ?? 0)) : requirements).map(req => {
                  const src = window.localStorage.getItem('dsh-studio:reqsrc') ?? 'all'
                  if (src !== 'all' && (req.source === 'business' ? 'business' : 'internal') !== src) return null
                  const tasks = tasksOf(req.id)
                  const reqDone = tasks.filter(task => task.status === 'done').length
                  const pct = req.progress?.progress ?? (tasks.length === 0 ? 0 : Math.round((reqDone / tasks.length) * 100))
                  const gate = req.progress?.gate ?? null
                  return h('div', {
                    key: req.id,
                    className: 'ds-req-item',
                    'data-on': req.id === selected ? '1' : '0',
                    onClick: () => setSelected(req.id),
                  },
                    h('div', { className: 'ds-req-item-title' }, req.title),
                    h('div', { className: 'ds-req-item-meta' },
                      h(ChipField, { className: 'ds-chip ds-chip-code' }, req.code || '未编号'),
                      req.source === 'business' ? h(ChipField, { className: 'ds-chip', 'data-src': 'business', title: [req.requester?.name, req.requester?.dept].filter(Boolean).join(' · ') || '业务提单' }, '业务提单') : null,
                      h(ChipField, { className: 'ds-chip', 'data-req': req.status }, REQ_STATUS_LABEL[req.status] ?? req.status),
                      h('span', { className: 'ds-hint' }, `${reqDone}/${tasks.length} 卡`),
                      gate === null ? null : h('span', { className: 'ds-hint', style: { color: gate.ready ? '#0f9d58' : '#b26a00' } },
                        gate.ready ? '准出通过' : `还差 ${gate.blockers.length} 项`),
                    ),
                    h('div', { className: 'ds-check-bar', 'data-full': pct === 100 ? '1' : '0', style: { marginTop: 2 } },
                      h('span', { style: { width: `${pct}%` } })),
                  )
                }),
          ),
          h('div', { className: 'ds-req-detail' }, detail),
        ),
      )
    }
