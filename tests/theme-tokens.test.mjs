// 主题变量的三个「静默失效」：特异性 0 的覆盖、深色缺 token、var() 无回退。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('灰字覆盖不能用 :where()（特异性 0，永远输给 theme.css 的 [data-dsh-studio]）', () => {
  const css = source('web/src/index.css')
  // 只关心那段「把灰字调深」的覆盖：它必须挂在有特异性的选择器上
  const blocks = [...css.matchAll(/:where\(\[data-dsh-studio\]\) \{([^}]*)\}/g)].map(match => match[1])
  const grayOverride = blocks.find(body => body.includes('--color-text-secondary'))
  assert.equal(grayOverride, undefined, '这段覆盖不能再挂 :where()（特异性 0 = 从未生效）')
  assert.match(css, /\[data-dsh-studio\], \[data-dsh-studio-portal\] \{[^}]*--color-text-tertiary/, '要挂在 0,1,0 的选择器上')
})

test('深色主题必须自己定义 text-secondary（否则继承浅色 neutral-500，落在 neutral-800 上只有 2.6:1）', () => {
  const theme = source('web/src/boardui/theme.css')
  const darkAt = theme.indexOf('.dark {')
  assert.ok(darkAt > 0, '找不到 .dark 块')
  const dark = theme.slice(darkAt)
  assert.match(dark, /--color-text-secondary:\s*var\(--color-neutral-(300|400)\)/, '深色要显式给 text-secondary')
  assert.match(dark, /--color-text-tertiary:\s*var\(--color-neutral-(400|500)\)/, '深色 tertiary 不能是 neutral-600')
  assert.match(dark, /--color-separator-border:\s*var\(--color-neutral-(500|600)\)/, '深色分隔线不能与面板底色同值')
})

test('--font-mono 的 var() 必须有回退（宿主没注入 --font-mono-source 时整条声明会失效）', () => {
  const theme = source('web/src/boardui/theme.css')
  const line = theme.split(/\r?\n/).find(text => text.includes('--font-mono:'))
  assert.ok(line !== undefined, '找不到 --font-mono 声明')
  assert.match(line, /var\(--font-mono-source,\s*["']?JetBrains Mono["']?\)[\s\S]*ui-monospace/, '要给 ui-monospace 当回退')
})
