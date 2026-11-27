/* 运行托盘：1.5 秒轻轮询 /agents，在顶栏显示「谁在跑 / 有没有停摆」。
 *
 * 为什么单独一个模块：client.src.js 有 2500 行闸门，而且整包 /state 是给看板用的
 * （几百 KB、15 秒一次）。运行态要的是「现在谁在跑」这种几 KB、秒级的数据，
 * 所以只打 /agents，不碰整包状态。
 *
 * 显示三态：
 *   - 有会话在跑：绿点 + 「AI 在跑 N」，点开看卡片 / 专家 / 跑了多久；
 *   - 没会话但有停摆卡：红点 + 「停摆 N 张」（崩过 / 被中断，不会自己恢复）；
 *   - 都 0：灰点 + 「AI 空闲」。
 *
 * 零新依赖、零新页面：原生 <details> 负责展开/收起和键盘操作。
 * 外观走 BoardUI token（点用 status-rose/lime/tertiary，面板 card + separator-border），
 * 不再引用 --ds-danger-text / --ds-muted 那批 legacy 变量。
 * `data-run-tray` 是探针钩子（tools/visual/panel-probe.mjs 按它读运行数）。
 */

const SUMMARY = 'flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1 text-caption-1-regular text-text-tertiary'
const DOT = 'inline-block size-[7px] flex-none rounded-full'
const PANEL = 'absolute right-0 top-[calc(100%+6px)] z-30 w-[min(380px,92vw)] min-w-[280px] rounded-lg border border-separator-border bg-background-primary-default p-2 shadow-lg'
const ROW = 'border-t border-separator-border py-1 first:border-t-0'
const ROW_TITLE = 'flex items-center gap-1 text-caption-1-regular text-text-primary'
const ROW_META = 'text-caption-2-regular text-text-tertiary'
const ERROR = 'p-1 text-caption-2-regular text-text-error-primary'

export function createRunTray({ h, React, api }) {
  const elapsed = ms => {
    const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
    if (total < 60) return `${total}s`
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
  }

  function RunTray({ state, onOpenTask }) {
    const [agents, setAgents] = React.useState(null)
    const [failed, setFailed] = React.useState(false)

    React.useEffect(() => {
      let alive = true
      const read = async () => {
        try {
          const out = await api('/agents')
          if (!alive) return
          if (out !== null && out !== undefined && out.ok !== false) {
            setAgents(out)
            setFailed(false)
          } else {
            setFailed(true)
          }
        } catch {
          if (alive) setFailed(true)
        }
      }
      void read()
      const timer = window.setInterval(() => {
        if (document.hidden !== true) void read()
      }, 1500)
      const onVisible = () => {
        if (document.hidden !== true) void read()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        alive = false
        window.clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisible)
      }
    }, [])

    const running = Array.isArray(agents?.running) ? agents.running : []
    const stalled = (state.tasks ?? []).filter(task => task.stalled === true).length
    const label = failed
      ? '运行态读取失败'
      : running.length > 0
        ? `AI 在跑 ${running.length}`
        : stalled > 0 ? `停摆 ${stalled} 张` : 'AI 空闲'
    /* 红 / 绿 / 灰三态的点：token 直出，暗色主题跟着 BoardUI 走。 */
    const dot = failed || stalled > 0
      ? 'bg-status-rose-text'
      : running.length > 0 ? 'bg-status-lime-text' : 'bg-text-tertiary'

    const row = info => {
      const task = (state.tasks ?? []).find(item => item.id === info.taskId)
      const expert = (state.config?.experts ?? []).find(item => item.id === info.expert)
      /* 看到异常会话后还得回看板找卡，等于白看：整行可点，直接打开那张卡的抽屉。 */
      const open = () => { if (typeof onOpenTask === 'function' && info.taskId) onOpenTask(String(info.taskId)) }
      return h('div', {
        key: String(info.sessionId ?? info.taskId ?? info.expert),
        className: ROW + (typeof onOpenTask === 'function' ? ' cursor-pointer rounded hover:bg-background-secondary-hover' : ''),
        'data-run-row': '',
        ...(typeof onOpenTask === 'function' ? {
          role: 'button',
          tabIndex: 0,
          title: '打开这张卡',
          onClick: open,
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } },
        } : {}),
      },
        h('div', { className: ROW_TITLE },
          h('b', { className: 'font-semibold text-text-primary' }, task?.code || String(info.taskId ?? '任务')),
          h('span', { className: 'min-w-0 truncate' }, task?.title ?? '（卡可能已被删除）'),
        ),
        h('div', { className: ROW_META },
          `${expert?.name ?? info.expert ?? '专家'} · 已跑 ${elapsed(Date.now() - (Number(info.at) || Date.now()))}`),
      )
    }

    return h('details', {
      className: 'relative inline-block',
      'data-run-tray': String(running.length),
      'data-stalled': String(stalled),
    },
      h('summary', {
        className: SUMMARY,
        title: '运行托盘：谁在跑、有没有卡停摆（1.5 秒刷新；点开看明细）',
      },
        h('span', { className: `${DOT} ${dot}`, 'aria-hidden': 'true' }),
        h('span', {}, label),
        running.length > 0
          ? h('span', { className: ROW_META }, `${running.length}/${agents?.maxConcurrent ?? '—'}`)
          : null),
      h('div', { className: PANEL, 'data-run-tray-panel': '' },
        failed
          ? h('div', { className: ERROR }, '读不到 /agents：可能是派单引擎还没起来，或服务刚重启。')
          : null,
        running.length === 0 && stalled === 0 && !failed
          ? h('div', { className: ERROR, 'data-run-tray-empty': '' }, '没有正在跑的专家会话。')
          : null,
        running.map(row),
        stalled > 0 && running.length === 0
          ? h('div', { className: ERROR },
            `${stalled} 张卡停在「正在跑」但会话已不在：去工作台看「停摆」清单，或打开卡片重试。`)
          : null,
        agents?.lastError
          ? h('div', { className: ERROR }, `最近错误：${String(agents.lastError).slice(0, 160)}`)
          : null,
      ),
    )
  }

  return RunTray
}
