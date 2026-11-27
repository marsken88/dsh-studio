// 执行记录 P0 批（专家评审）：结论优先、语义上色、去重复动作。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const drawer = () => readFileSync(new URL('../web/src/studio/drawer.js', import.meta.url), 'utf8')

test('评审徽标按语义上色（通过绿 / 要求修改红 / 待评审黄），不再是恒 gray', () => {
  const s = drawer()
  assert.match(s, /const REVIEW_CHIP_VARIANT = \{ approved: 'lime', changes_requested: 'rose', pending: 'yellow' \}/)
  assert.match(s, /variant: REVIEW_CHIP_VARIANT\[coding\.review\.status\]/, '徽标要用这张映射')
})

test('结论行：谁、什么时候、合并门禁还差几项', () => {
  const s = drawer()
  assert.match(s, /'data-review-conclusion'/, '要有结论行钩子')
  assert.match(s, /task\.mergeGate\?\.blockers/, '还差几项取合并门禁的 blockers')
  assert.match(s, /还差 \$\{blockers\.length\} 项/, '缺项要写明数量')
})

test('单测徽标带失败数；没有单测时不显示成绿', () => {
  const s = drawer()
  assert.match(s, /`单测 \$\{passed\}\/\$\{total\}\$\{failed > 0 \? ` · 失败 \$\{failed\}` : ''\}`/)
  assert.match(s, /variant: failed > 0 \? 'rose' : 'lime'/)
  assert.match(s, /'无单测'/, '0 条单测要单独一档，不能显示成通过')
})

test('「核对代码事实」没有 worktree 时不隐藏（disabled + 说清原因）', () => {
  const s = drawer()
  assert.match(s, /worktree === null\r?\n\s+\? tipOf\('这张卡还没有 worktree/, '缺 worktree 要给按钮和原因，而不是整个消失')
  assert.ok(!/worktree === null \? null : tipOf\(/.test(s), '旧写法（直接不渲染按钮）要消失')
})

test('删掉会误导的「标记已合并」（它只写 mergedAt，并不合并）', () => {
  const s = drawer()
  assert.ok(!/mergeCoding/.test(s), '不再保留 mergeCoding（真合并走合并门禁的「合并 MR」）')
  assert.ok(!/'标记已合并'/.test(s), '按钮名也不能留在渲染里')
})

test('评审主行动唯一：评审通过 = primary，要求修改 = secondary', () => {
  const s = drawer()
  assert.match(s, /variant: 'primary', size: 'sm', disabled: busy, onClick: \(\) => void reviewCoding\('approved'\)/, '评审通过要是主行动')
  assert.match(s, /variant: 'secondary', size: 'sm', disabled: busy, onClick: \(\) => void reviewCoding\('changes_requested'\)/)
})

test('文件清单：一行统计（含增删合计）+ Top3 + 展开其余', () => {
  const s = drawer()
  const block = s.slice(s.indexOf("'data-coding-files': ''"), s.indexOf("'data-coding-files': ''") + 2000)
  assert.match(block, /个文件/, '要有「N 个文件」')
  assert.match(block, /tabular-nums text-state-success-text/, '+ 行数要带色且等宽对齐')
  assert.match(block, /tabular-nums text-text-error-primary/, '− 行数同理')
  assert.match(s, /const top = byWeight\.slice\(0, 3\)/, '默认只列 Top3')
  assert.match(block, /data-coding-files-rest/, '其余要能展开')
})

test('上下文与评审意见默认折叠（600 字 note 不再整段铺开）', () => {
  const s = drawer()
  assert.match(s, /'data-coding-context': ''/, '上下文要折叠')
  assert.match(s, /'data-review-note-full': ''/, '评审意见要折叠')
  assert.match(s, /text-caption-1-medium text-text-secondary' \},\s*`评审意见/, 'label（谁·何时）与正文要分开')
})

test('P2：提交列表折叠 + 行内 code 有容器 + 空态文案不重复', () => {
  const s = drawer()
  assert.match(s, /'data-coding-commits': ''/, '本块提交要折叠')
  assert.match(s, /'data-gitlab-commits': ''/, 'GitLab 提交要折叠')
  assert.match(s, /const CODE_CHIP = 'shrink-0 rounded bg-background-secondary-default px-1 font-mono/, '行内 code 要容器 + 等宽 + 字阶')
  assert.match(s, /h\('code', \{ className: CODE_CHIP \}/, '提交号要用它')
  assert.ok(!/hint: '改代码要留记录：谁、什么模型、改了什么。'/.test(s), '空态 hint 不该与小节说明逐字重复')
})
