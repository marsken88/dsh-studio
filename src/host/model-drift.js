/* 派单会话的「模型漂移」判定（纯函数）。
 *
 * 宿主把模型**固化在会话创建时**：改专家设置只影响新建会话，老会话还按创建时的型号跑。
 * 派单又会在 `agents.create` 撞到同名会话时静默 fallback 到 resume ——
 * 于是「设置里配的是 Flash，实际每次请求都是 Pro」这种状态长期不可见，
 * 真机是靠新加的执行播报（评论里写出实际模型）才发现的。
 *
 * 这里只做判定与路径推算，IO 由 dispatcher 负责：真的重建会话要 abort + 归档目录。
 */

/** 会话现在用的模型 vs 配置要的模型，是否已经漂移。 */
export function isModelDrift(current, wanted) {
  if (current === null || current === undefined) return false       // 还没发出请求，判断不了
  if (wanted === null || wanted === undefined) return false        // 没配置，谈不上漂移
  const wantModel = String(wanted.model ?? '').trim()
  if (wantModel === '') return false
  const gotModel = String(current.model ?? '').trim()
  if (gotModel !== wantModel) return true
  const wantProvider = String(wanted.provider ?? '').trim()
  const gotProvider = String(current.provider ?? '').trim()
  // provider 只在配置里写了时才比：没写就是「借宿主默认」，不算漂移
  return wantProvider !== '' && gotProvider !== '' && gotProvider !== wantProvider
}

/** 漂移时给人看的一句话（写进卡上的评论，不用再翻日志）。 */
export function driftNote(current, wanted, action = '归档旧会话并按配置重建') {
  const got = `${String(current?.provider ?? '?')}/${String(current?.model ?? '?')}`
  const want = `${String(wanted?.provider ?? '')}/${String(wanted?.model ?? '?')}`.replace(/^\//, '')
  return `模型漂移：这个会话用的是 \`${got}\`，配置要的是 \`${want}\`——会话的模型在创建时固化，改设置不会影响老会话。已${action}。`
}

/** DSH 的会话目录名：cwd 里的非字母数字压成 '-'，两端各包 '--'。
 *  例：`C:\\Users\\hp\\dsh-workspace` → `--C-Users-hp-dsh-workspace--`；
 *      `/home/<user>/dsh-workspace` → `--home-<user>-dsh-workspace--`。 */
export function sessionWorkspaceSlug(cwd) {
  const text = String(cwd ?? '').trim()
  if (text === '') return ''
  return `--${text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}--`
}

/** 一个会话在磁盘上的目录（重建时改名用）。 */
export function sessionDirOf(home, cwd, sessionId) {
  const slug = sessionWorkspaceSlug(cwd)
  if (slug === '' || String(sessionId ?? '') === '') return ''
  return [String(home), '.dsh', 'sessions', slug, String(sessionId)].join('/')
}
