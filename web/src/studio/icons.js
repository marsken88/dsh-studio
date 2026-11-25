/**
 * 一套线性图标：一个尺寸（14）、一种描边（1.75）。
 *
 * 为什么要有这个文件：体检（npm run audit:ui）在 32 个面里量到 18 个 emoji 图形符号
 * 当图标用 —— 每个系统渲染出来的样子都不一样，尺寸、基线、颜色全不由我们控制。
 * 这里把「符号 → 语义」收成一张表，界面只按语义取图标。
 *
 * 路径数据取自 lucide v0.475.0（ISC 许可）。**故意不 import lucide-react**：
 * 契约测试（tests/client-units.test.mjs）要在没有 node_modules 的环境里跑（CI 就是），
 * 图标模块一旦依赖包，这条测试就只能在装过依赖的机器上过。数据是静态的，直接带在身上。
 *
 * 两个约定：
 *   1. 图标永远跟着文字的颜色走（currentColor），不单独上色；
 *   2. 状态不用图标表达，用 6px 圆点（statusDot）+ 文字：形状固定、颜色只表意。
 *
 * 用法（这些模块都是 h() 写法，所以图标也从传入的 createElement 构造）：
 *   import { uiIcon, statusDot, expertIconName } from './icons.js'
 *   uiIcon(h, 'file')                      // 14px 线性图标
 *   uiIcon(h, 'checks', { size: 12 })      // 小一号
 *   statusDot(h, 'danger')                 // 6px 状态点
 *   uiIcon(h, expertIconName(expert))      // 按专家角色取图标
 */

const NODES = {
  file: [["path",{"d":"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z","key":"1rqfz7"}],["path",{"d":"M14 2v4a2 2 0 0 0 2 2h4","key":"tnqrlb"}],["path",{"d":"M10 9H8","key":"b1mrlr"}],["path",{"d":"M16 13H8","key":"t4e002"}],["path",{"d":"M16 17H8","key":"z1uh3a"}]],
  checks: [["path",{"d":"m3 17 2 2 4-4","key":"1jhpwq"}],["path",{"d":"m3 7 2 2 4-4","key":"1obspn"}],["path",{"d":"M13 6h8","key":"15sg57"}],["path",{"d":"M13 12h8","key":"h98zly"}],["path",{"d":"M13 18h8","key":"oe0vm4"}]],
  attach: [["path",{"d":"M13.234 20.252 21 12.3","key":"1cbrk9"}],["path",{"d":"m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486","key":"1pkts6"}]],
  clock: [["circle",{"cx":"12","cy":"12","r":"10","key":"1mglay"}],["polyline",{"points":"12 6 12 12 16 14","key":"68esgv"}]],
  warn: [["path",{"d":"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3","key":"wmoenq"}],["path",{"d":"M12 9v4","key":"juzpu7"}],["path",{"d":"M12 17h.01","key":"p32p05"}]],
  team: [["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2","key":"1yyitq"}],["circle",{"cx":"9","cy":"7","r":"4","key":"nufk8"}],["path",{"d":"M22 21v-2a4 4 0 0 0-3-3.87","key":"kshegd"}],["path",{"d":"M16 3.13a4 4 0 0 1 0 7.75","key":"1da9ce"}]],
  skill: [["path",{"d":"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z","key":"w46dr5"}]],
  role: [["circle",{"cx":"12","cy":"12","r":"10","key":"1mglay"}],["circle",{"cx":"12","cy":"12","r":"6","key":"1vlfrh"}],["circle",{"cx":"12","cy":"12","r":"2","key":"1c9p78"}]],
  suite: [["path",{"d":"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z","key":"1a0edw"}],["path",{"d":"M12 22V12","key":"d0xqtd"}],["polyline",{"points":"3.29 7 12 12 20.71 7","key":"ousv84"}],["path",{"d":"m7.5 4.27 9 5.15","key":"1c824w"}]],
  retry: [["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}]],
  run: [["polygon",{"points":"6 3 20 12 6 21 6 3","key":"1oa8hb"}]],
  memory: [["path",{"d":"M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z","key":"l5xja"}],["path",{"d":"M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z","key":"ep3f8r"}],["path",{"d":"M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4","key":"1p4c4q"}],["path",{"d":"M17.599 6.5a3 3 0 0 0 .399-1.375","key":"tmeiqw"}],["path",{"d":"M6.003 5.125A3 3 0 0 0 6.401 6.5","key":"105sqy"}],["path",{"d":"M3.477 10.896a4 4 0 0 1 .585-.396","key":"ql3yin"}],["path",{"d":"M19.938 10.5a4 4 0 0 1 .585.396","key":"1qfode"}],["path",{"d":"M6 18a4 4 0 0 1-1.967-.516","key":"2e4loj"}],["path",{"d":"M19.967 17.484A4 4 0 0 1 18 18","key":"159ez6"}]],
  resultPass: [["circle",{"cx":"12","cy":"12","r":"10","key":"1mglay"}],["path",{"d":"m9 12 2 2 4-4","key":"dzmm74"}]],
  resultFail: [["circle",{"cx":"12","cy":"12","r":"10","key":"1mglay"}],["path",{"d":"m15 9-6 6","key":"1uzhvr"}],["path",{"d":"m9 9 6 6","key":"z0biqf"}]],
  resultPending: [["path",{"d":"M10.1 2.182a10 10 0 0 1 3.8 0","key":"5ilxe3"}],["path",{"d":"M13.9 21.818a10 10 0 0 1-3.8 0","key":"11zvb9"}],["path",{"d":"M17.609 3.721a10 10 0 0 1 2.69 2.7","key":"1iw5b2"}],["path",{"d":"M2.182 13.9a10 10 0 0 1 0-3.8","key":"c0bmvh"}],["path",{"d":"M20.279 17.609a10 10 0 0 1-2.7 2.69","key":"1ruxm7"}],["path",{"d":"M21.818 10.1a10 10 0 0 1 0 3.8","key":"qkgqxc"}],["path",{"d":"M3.721 6.391a10 10 0 0 1 2.7-2.69","key":"1mcia2"}],["path",{"d":"M6.391 20.279a10 10 0 0 1-2.69-2.7","key":"1fvljs"}]],
  resultSkip: [["polygon",{"points":"5 4 15 12 5 20 5 4","key":"16p6eg"}],["line",{"x1":"19","x2":"19","y1":"5","y2":"19","key":"futhcm"}]],
  expertProduct: [["rect",{"width":"8","height":"4","x":"8","y":"2","rx":"1","ry":"1","key":"tgr4d6"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2","key":"116196"}],["path",{"d":"M12 11h4","key":"1jrz19"}],["path",{"d":"M12 16h4","key":"n85exb"}],["path",{"d":"M8 11h.01","key":"1dfujw"}],["path",{"d":"M8 16h.01","key":"18s6g9"}]],
  expertArchitect: [["line",{"x1":"3","x2":"21","y1":"22","y2":"22","key":"j8o0r"}],["line",{"x1":"6","x2":"6","y1":"18","y2":"11","key":"10tf0k"}],["line",{"x1":"10","x2":"10","y1":"18","y2":"11","key":"54lgf6"}],["line",{"x1":"14","x2":"14","y1":"18","y2":"11","key":"380y"}],["line",{"x1":"18","x2":"18","y1":"18","y2":"11","key":"1kevvc"}],["polygon",{"points":"12 2 20 7 4 7","key":"jkujk7"}]],
  expertDev: [["path",{"d":"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z","key":"cbrjhi"}]],
  expertQa: [["path",{"d":"M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2","key":"18mbvz"}],["path",{"d":"M6.453 15h11.094","key":"3shlmq"}],["path",{"d":"M8.5 2h7","key":"csnxdl"}]],
  expertDefault: [["path",{"d":"M12 8V4H8","key":"hb8ula"}],["rect",{"width":"16","height":"12","x":"4","y":"8","rx":"2","key":"enze0r"}],["path",{"d":"M2 14h2","key":"vft8re"}],["path",{"d":"M20 14h2","key":"4cs60a"}],["path",{"d":"M15 13v2","key":"1xurst"}],["path",{"d":"M9 13v2","key":"rq6x2g"}]],
}

const SVG_BASE = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

export const ICON_NAMES = Object.keys(NODES)

/** 渲染一个图标；名字不认识时返回 null（宁可不画，也不画错的）。 */
export function uiIcon(createElement, name, props = {}) {
  const nodes = NODES[name]
  if (nodes === undefined) return null
  const { size = 14, strokeWidth = 1.75, className, ...rest } = props
  return createElement(
    'svg',
    {
      ...SVG_BASE,
      width: size,
      height: size,
      strokeWidth,
      'aria-hidden': 'true',
      focusable: 'false',
      ...rest,
      // 尺寸/颜色/基线一律用工具类：图标永远跟着文字颜色走（currentColor），不单独上色。
      className: ['flex-none align-[-2px] text-current', className].filter(Boolean).join(' '),
    },
    nodes.map((node, index) => createElement(node[0], { ...node[1], key: index })),
  )
}

/** 状态点在语义上的那几档颜色：只用 BoardUI 的状态 token，不写实色。 */
const DOT_TONE = {
  ok: 'bg-status-lime-text',
  warn: 'bg-status-yellow-text',
  danger: 'bg-status-rose-text',
  info: 'bg-accent-500',
  idle: 'bg-text-tertiary',
}

/** 6px 状态点。kind: ok / warn / danger / info / idle。 */
export function statusDot(createElement, kind, props = {}) {
  const tone = DOT_TONE[kind] ?? DOT_TONE.idle
  return createElement('span', { className: `inline-block size-1.5 flex-none rounded-full ${tone}`, 'data-kind': kind, 'aria-hidden': 'true', ...props })
}

const ROLE_ICON = {
  product: 'expertProduct',
  architect: 'expertArchitect',
  dev: 'expertDev',
  qa: 'expertQa',
}

/**
 * 专家/角色 → 图标名。
 * 专家的 emoji 是历史数据字段（config.experts[].emoji），界面不再渲染它：
 * 图标由角色决定，同角色同图标，一眼能认出这是产品还是测试。
 */
export function expertIconName(entity) {
  if (entity === null || entity === undefined) return 'expertDefault'
  return ROLE_ICON[entity.role] ?? ROLE_ICON[entity.id] ?? 'expertDefault'
}

/** 用例/清单四态的语义键，配 CSS 上色用。 */
export const RESULT_KIND = {
  pending: 'idle',
  pass: 'ok',
  fail: 'danger',
  skip: 'idle',
}
