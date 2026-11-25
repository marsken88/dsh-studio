/* 桌面客户端（Electron）的标题栏下沉量。
 *
 * 踩过的坑：
 *   1. 0.9.5 用 top: env(titlebar-area-height, 0px) —— 桌面客户端里实测是 **0**，覆盖层依旧压在最上层
 *      （issue #4 二次复现：抽屉关闭按钮 y 25–60 与窗口按钮 y 15–40 重叠）。
 *   2. 0.9.12 改成"UA 里带 Electron 就下沉 32px" —— 用户重启后截图量出来还是 y≈13，
 *      说明这个客户端把 UA 里的 Electron 段去掉了。
 *
 * 所以不再猜：直接找窗口顶部那条 -webkit-app-region: drag 的标题栏，量它的高度。
 * 量不到才退回 UA 判断，再退回 0（Web 版没有这条标题栏，行为不变）。
 */

function dragRegionHeight(win) {
  try {
    const doc = win.document
    const xs = [0.08, 0.3, 0.5, 0.7, 0.9].map(ratio => Math.round(win.innerWidth * ratio))
    let height = 0
    for (const x of xs) {
      for (const el of doc.elementsFromPoint(x, 4)) {
        const style = win.getComputedStyle(el)
        const region = style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region')
        if (String(region).trim() !== 'drag') continue
        const rect = el.getBoundingClientRect()
        if (rect.top <= 2 && rect.height >= 16 && rect.height <= 120) {
          height = Math.max(height, Math.round(rect.height))
        }
      }
    }
    return height
  } catch {
    return 0
  }
}

/** 设置 --ds-titlebar-floor 并返回最终下沉像素。 */
export function applyTitlebarFloor(win = typeof window === 'undefined' ? undefined : window) {
  try {
    const doc = win?.document
    if (doc === undefined) return 0
    let floor = dragRegionHeight(win)
    /* UA 里的 Electron 段可能被客户端去掉（0.9.12 实测如此），所以再补两条信号：
       process.versions.electron（Electron 注入）与 window.process?.type === 'renderer'。 */
    const electronish = floor > 0
      || /Electron/i.test(String(win.navigator?.userAgent ?? ''))
      || typeof win.process?.versions?.electron === 'string'
      || win.process?.type === 'renderer'
    if (floor === 0 && electronish) floor = 32
    if (floor > 0) doc.documentElement.style.setProperty('--ds-titlebar-floor', floor + 'px')
    return floor
  } catch {
    return 0
  }
}
