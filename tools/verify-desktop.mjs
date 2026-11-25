#!/usr/bin/env node
/**
 * 桌面版（Electron 客户端）验收：能自动验的部分都在这，验不了的说清楚。
 *
 *   npm run verify:desktop                     # 自动取 DSH_WEB_URL
 *   DESKTOP_BASE=http://127.0.0.1:55147 npm run verify:desktop
 *
 * 自动验：插件是否加载、/state.profile 是否等于当前 profile、/market.installed 里有没有本插件、
 *        破坏性路由是否要求 confirm。
 * 验不了：客户端半边（侧栏入口、面板渲染）—— 桌面窗口走 dsh-app:// + 启动令牌，
 *        外部浏览器拿不到那个页面。这一半只能人眼确认，脚本会在结尾写清楚。
 *
 * 需要 STUDIO_TOKEN（`/studio-api` 过宿主的信任栅栏，脚本要用 dsh web 的启动 token 换 cookie）：
 *   STUDIO_TOKEN=<dsh web 启动 token> DESKTOP_BASE=http://127.0.0.1:55147 npm run verify:desktop
 */
import { launchTokenFromEnv, studioFetch } from './lib/studio-auth.mjs'

const base = String(process.env.DESKTOP_BASE ?? process.env.DSH_WEB_URL ?? '').replace(/\/+$/, '')
if (base === '') {
  console.error('需要 DESKTOP_BASE 或 DSH_WEB_URL（形如 http://127.0.0.1:55147）')
  process.exit(2)
}
const api = studioFetch(base, launchTokenFromEnv())
const expectedProfile = process.env.EXPECTED_PROFILE ?? process.env.DSH_PROFILE ?? 'desktop'

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); return ok }
const post = async (path, body) => {
  const res = await api('/studio-api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

const stateRes = await api('/studio-api/state')
if (stateRes.status !== 200) {
  console.log(`FAIL /studio-api/state → ${stateRes.status}`)
  console.log('插件没加载。检查：① package.json 的 dependencies 里有本插件；')
  console.log('② 同一份 package.json 的 dsh.profile.bundles 里有本插件（只写 dependencies 不会加载）；')
  console.log('③ node_modules/@marsken/dsh-studio 指向仓库；④ 重启客户端。')
  process.exit(1)
}
const state = (await stateRes.json()).state ?? {}
check('插件已加载', true, `tasks=${(state.tasks ?? []).length}`)
check(
  `profile 识别为 ${expectedProfile}`,
  state.profile === expectedProfile,
  `profile=${state.profile}（回退成 web 说明 detectProfile 没认出 scoped 包名）`,
)

const market = await (await api('/studio-api/market')).json()
const installed = Array.isArray(market?.installed) ? market.installed : []
check('/market.installed 非空', installed.length > 0, `installed=${installed.length}`)
check(
  '/market.installed 里有本插件',
  installed.some(item => JSON.stringify(item).includes('@marsken/dsh-studio') || JSON.stringify(item).includes('dsh-studio')),
  installed.slice(0, 3).map(item => item.name ?? item).join(', '),
)

const noConfirm = await post('/task/delete', { id: 't-nope' })
check('破坏性路由缺 confirm → 400', noConfirm.status === 400 && noConfirm.text.includes('confirm_required'), `${noConfirm.status}`)

for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? ' — ' + item.detail : ''}`)
const failed = checks.filter(item => !item.ok).length
console.log('')
console.log('人工确认（脚本验不了）：桌面窗口走 dsh-app:// + 启动令牌，外部浏览器打不开那个页面。')
console.log('  · 侧栏是否出现「需求&任务工作空间」→ 没有就 Ctrl+R 重载页面，再没有就重启客户端')
console.log('  · 点开看板：0 张卡时应显示「还没有任何卡」，且不出现「渲染失败」')
console.log('  · 打开任何一个弹层：顶部不应被窗口的最小化/关闭按钮遮住')
console.log('')
console.log(failed === 0 ? `桌面版 host 半边验收通过（${checks.length} 项）` : `桌面版验收不通过（${failed} 项）`)
process.exit(failed === 0 ? 0 : 1)
