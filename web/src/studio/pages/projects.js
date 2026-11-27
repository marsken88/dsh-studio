/* 项目页：业务项目 / 迭代 / 每个服务的本机目录与卡数。
 *
 * 这一版整页改用 BoardUI（Tailwind v4 + token + 4px 档位），不再用那套手写类：
 *   - 卡片表面：rounded-xl + border-separator-border + bg-background-primary-default
 *   - 数字/标签：text-title-2-semibold / text-caption-1-regular / tabular-nums
 *   - 进度条：BoardUI 的 ProgressTrack（轨道与填充都来自 theme.css，不再自己写进度条类）
 *   - 空态：boardui/empty-state（BoardUI 没有空态组件，这是它家 token 拼的等价物）
 *   - 动作：boardui/index 的 Button（variant/size 由适配层翻译）
 */
import { Button } from '../../boardui/index'
import { fmtTime } from '../format.js'
import { EmptyState } from '../../boardui/empty-state'
import { ProgressTrack } from '../../components/base/progress/progress'

const SURFACE = 'flex min-w-0 flex-col gap-3 rounded-xl border border-separator-border bg-background-primary-default p-4'
const STAT_LABEL = 'text-caption-1-regular text-text-tertiary'
const STAT_VALUE = 'text-title-2-semibold text-text-primary tabular-nums'
const HINT = 'text-caption-1-regular text-text-tertiary'

export function createProjectsPage({ h, React, api }) {
  return function ProjectsOverview({ state, onOpenBoard, onOpenSettings }) {
    const [metrics, setMetrics] = React.useState(null)
    const [error, setError] = React.useState(null)
    React.useEffect(() => {
      let alive = true
      api('/metrics')
        .then(out => { if (alive) setMetrics(out.metrics) })
        .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
      return () => { alive = false }
    }, [state.revision])

    if (error !== null) {
      return h('div', { className: 'p-6' },
        h('div', { className: 'rounded-xl border border-separator-border bg-background-primary-default p-4 text-body-2-regular text-text-error-primary' }, error),
      )
    }
    /* /metrics 回包缺 metrics 字段时（版本错配 / 后端换形状）不能整页崩：
       以前只判 === null，undefined 会走到 metrics.projects 直接抛，
       React 错误边界把整个工作空间换成「渲染失败」。 */
    if (metrics === null || metrics === undefined) {
      return h('div', { className: 'p-6 text-body-2-regular text-text-secondary', 'data-projects-loading': '' }, '正在统计…')
    }

    const stat = (value, label, warn) => h('div', { className: 'flex flex-col gap-1' },
      h('span', { className: warn === true ? `${STAT_VALUE} text-text-error-primary` : STAT_VALUE }, value),
      h('span', { className: STAT_LABEL }, label),
    )

    const card = (title, subtitle, data, key, iterationNode) => h('div', { className: SURFACE, key, 'data-project-card': '' },
      h('div', { className: 'flex items-start justify-between gap-3' },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('div', { className: 'truncate text-body-2-medium text-text-primary', title }, title),
          h('div', { className: HINT }, subtitle),
        ),
        h(Button, { variant: 'secondary', size: 'sm', onClick: () => onOpenBoard(key) }, '看这些卡'),
      ),
      h('div', { className: 'grid grid-cols-3 gap-3' },
        stat(data.inProgress ?? 0, '进行中'),
        stat(data.blocked ?? 0, '阻塞', Number(data.blocked) > 0),
        stat(data.overdue ?? 0, '逾期', Number(data.overdue) > 0),
        stat(data.done ?? 0, '已完成'),
        stat(`${data.checklistRate ?? 0}%`, '清单完成'),
        stat(data.artifacts ?? 0, '交付物'),
      ),
      h(ProgressTrack, { percentage: Number(data.checklistRate) || 0, size: 'sm' }),
      iterationNode,
      h('div', { className: HINT },
        `近 7 天 新增 ${data.created7d ?? 0} · 完成 ${data.throughput7d ?? 0}`
        + (data.cycleDays > 0 ? ` · 平均周期 ${data.cycleDays} 天` : '')),
    )

    const iterationList = project => {
      const iterations = project.iterations ?? []
      if (iterations.length === 0) {
        return h('div', { className: HINT }, '还没建迭代：设置 → 项目与迭代里给这个项目加一条')
      }
      return h('div', { className: 'flex flex-col gap-2' },
        iterations.slice(0, 5).map(iteration => {
          const total = Number(iteration.total) || 0
          const done = Number(iteration.done) || 0
          const rate = total === 0 ? 0 : Math.round((done / total) * 100)
          return h('div', { className: 'flex min-w-0 items-center gap-3', key: iteration.id },
            h('span', {
              className: 'min-w-0 flex-1 truncate text-caption-1-regular text-text-secondary',
              title: `${iteration.start || '未定'} → ${iteration.due || '未定'}`,
            }, iteration.name || iteration.id),
            h('div', { className: 'w-24 shrink-0' }, h(ProgressTrack, { percentage: rate, size: 'sm' })),
            h('span', { className: 'shrink-0 text-caption-1-medium text-text-secondary tabular-nums' }, `${done}/${total}`),
          )
        }),
        /* 以前直接 slice(0,5) 了事：卡上写「7 个迭代」却只看到 5 行，人会以为数据丢了。 */
        iterations.length > 5
          ? h('div', { className: HINT, 'data-iteration-more': '' }, `还有 ${iterations.length - 5} 个迭代（去「设置 → 项目与迭代」看全部）`)
          : null,
      )
    }

    /* 首屏下方那块 400px 的空白：用「未归属项目的卡 / 最近更新」填上。
       项目页本来就是「哪些卡还没归属」最该被看到的地方，放一张清单比留白有用。 */
    const statusLabel = id => (state.statuses ?? []).find(item => item.id === id)?.label ?? String(id ?? '')
    const unassignedTasks = (state.tasks ?? [])
      .filter(task => String(task.project ?? '') === '')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const recentTasks = [...(state.tasks ?? [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const taskPanel = unassignedTasks.length > 0
      ? { title: `未归属项目的卡（${unassignedTasks.length}）`, subtitle: '还没挂到项目上的卡，先给它们选一个项目', rows: unassignedTasks.slice(0, 10) }
      : { title: '最近更新', subtitle: '最近有动静的卡（按更新时间）', rows: recentTasks.slice(0, 8) }

    const projects = metrics.projects ?? []
    const unassigned = metrics.unassigned
    const hasUnassigned = unassigned !== null && unassigned !== undefined && unassigned.total > 0

    return h('div', { className: 'flex flex-col gap-4 p-4', 'data-projects-page': '' },
      /* 项目页以前只能看、不能建：新建/编辑入口藏在设置里，人找不到。 */
      h('div', { className: 'flex flex-wrap items-center justify-between gap-2' },
        h('div', { className: 'flex min-w-0 flex-col gap-1' },
          h('span', { className: 'text-body-2-medium text-text-primary' }, `${projects.length} 个业务项目${hasUnassigned ? ' + 1 个未归属分组' : ''}`),
          h('span', { className: HINT }, '项目 → 迭代 → 卡；本机代码目录与服务在「设置 → 项目与迭代」里维护')),
        h(Button, { variant: 'secondary', size: 'sm', onClick: () => { if (typeof onOpenSettings === 'function') onOpenSettings() } }, '＋ 新建 / 管理项目'),
      ),
      h('div', { className: 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3' },
        projects.map(project => card(
          `${project.key ? `[${project.key}] ` : ''}${project.name}`,
          `${(project.iterations ?? []).length} 个迭代 · ${project.metrics.total ?? 0} 张卡`,
          project.metrics,
          project.id,
          // 迭代进度：每个迭代一行（名字 · 进度条 · 完成/总数）。数据来自 /metrics 的 iterations[].total/done，
          // 以前这里只数「有几个迭代」，看不出做到哪一步，首屏大半是空的。
          iterationList(project),
        )),
        hasUnassigned ? card('未归属项目', '还没挂到项目上的卡', unassigned, '', null) : null,
      ),
      projects.length === 0 && hasUnassigned === false
        ? h(EmptyState, {
          title: '还没有卡片',
          hint: '先去「设置 → 项目与迭代」建一个项目，再新建任务。',
          action: h(Button, { variant: 'secondary', size: 'sm', onClick: () => onOpenBoard('') }, '先去建卡'),
        })
        : null,
      taskPanel.rows.length === 0
        ? null
        : h('div', { className: SURFACE, 'data-projects-tasklist': '' },
          h('div', { className: 'flex min-w-0 flex-wrap items-center justify-between gap-3' },
            h('div', { className: 'flex min-w-0 flex-col gap-1' },
              h('div', { className: 'text-body-2-medium text-text-primary' }, taskPanel.title),
              h('div', { className: HINT }, taskPanel.subtitle),
            ),
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenBoard('') }, '去看板'),
          ),
          h('div', { className: 'flex min-w-0 flex-col' },
            taskPanel.rows.map(task => h('div', {
              key: task.id,
              className: 'flex min-w-0 items-center gap-3 border-b border-separator-border py-2 last:border-b-0',
              'data-project-task': task.id,
            },
              h('span', { className: 'shrink-0 font-mono text-caption-1-regular text-text-tertiary' }, task.code || task.id),
              h('span', { className: 'min-w-0 flex-1 truncate text-body-2-regular text-text-primary', title: task.title }, task.title),
              h('span', { className: 'shrink-0 text-caption-1-regular text-text-secondary' }, statusLabel(task.status)),
              h('span', { className: 'shrink-0 text-caption-1-regular text-text-tertiary tabular-nums' }, fmtTime(task.updatedAt)),
            )),
          ),
        ),
    )
  }
}
