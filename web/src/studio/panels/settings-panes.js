/* 设置页里仍内联在 client.src.js 的两块面板：看板外观 / 自动派单。
 *
 * 迁出来只换表现层（BoardUI token + 4px 档位），表单值、保存流程、字段顺序与选项都不变：
 *   · 分区 = 卡片（rounded-xl + border-separator-border + bg-background-primary-default + p-4）；
 *   · 字段 = 标签（caption）+ 控件，控件仍走共享的 TextField / SelectField / CheckField；
 *   · 动作走 BoardUI Button；保存结果用 token 色的小字。
 *
 * 这两块原先挂在旧 panel 的「壳 / 头 / 体」三层类上，是设置页外壳迁完后的最后一批。
 */
import { Button } from '../../boardui/index'
import { client } from '../context.js'

const PANE = 'flex min-w-0 flex-col gap-4'
const SECTION = 'flex min-w-0 flex-col gap-4 rounded-xl border border-separator-border bg-background-primary-default p-4'
const SECTION_TITLE = 'text-title-2-semibold text-text-primary'
const FIELD = 'flex min-w-0 flex-col gap-1'
const LABEL = 'text-caption-2-medium text-text-secondary'
const HINT = 'text-caption-1-regular text-text-tertiary'
const ERR = 'text-caption-1-regular text-text-error-primary'
const OK = 'text-caption-1-regular text-state-success-text'
const ROW = 'flex min-w-0 flex-wrap items-center gap-3'
const CHECK_ROW = 'flex cursor-pointer items-center gap-2 text-body-2-regular text-text-primary'
const CHECK_GROUP = 'flex flex-wrap items-center gap-4'

/** 一个字段行：标签 + 控件。`fieldKey` 对应 form 里的键。 */
export function SettingsField({ form, setForm, fieldKey, label, hint, type }) {
  const { h, TextField } = client()
  return h('div', { className: FIELD },
    h('div', { className: LABEL }, label),
    h(TextField, {
      'aria-label': label,
      type: type ?? 'text',
      value: form[fieldKey],
      placeholder: hint ?? '',
      onChange: e => setForm({ ...form, [fieldKey]: e.target.value }),
    }),
  )
}

/** 保存条：主按钮 + 结果/错误小字。粘在面板底部，滚到哪都能直接保存。 */
export function SettingsSaveBar({ busy, status, error, dirty, onSave }) {
  const { h } = client()
  return h('div', {
    className: 'sticky bottom-0 z-10 flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-separator-border bg-background-primary-default px-4 py-3 shadow-sm',
    'data-settings-savebar': '',
    'data-dirty': dirty === true ? '1' : '0',
  },
    h(Button, { variant: 'primary', size: 'sm', 'data-action': 'save', disabled: busy, onClick: () => void onSave() }, busy ? '保存中…' : '保存'),
    dirty === true ? h('span', { className: 'text-caption-1-medium text-text-secondary', 'data-savebar-dirty': '1' }, '未保存') : null,
    status !== null ? h('span', { className: OK }, status) : null,
    error !== null ? h('span', { className: ERR }, error) : null,
  )
}

/** 看板外观：只有标题一个字段。 */
export function BoardAppearancePane({ form, setForm, saveBar }) {
  const { h } = client()
  return h('div', { className: PANE, 'data-settings-pane': 'board' },
    h('div', { className: SECTION },
      h('div', { className: SECTION_TITLE }, '看板'),
      h(SettingsField, { form, setForm, fieldKey: 'boardTitle', label: '看板标题', hint: '需求&任务工作空间' }),
    ),
    saveBar,
  )
}

/** 自动派单：总开关、逐列开关、并发与沙箱/隔离选项。 */
export function AutoDispatchPane({ form, setForm, saveBar }) {
  const { h, CheckField, SelectField } = client()
  const field = (key, label, hint, type) => h(SettingsField, { key, form, setForm, fieldKey: key, label, hint, type })
  const selectOf = (label, key, options) => h('div', { className: FIELD },
    h('div', { className: LABEL }, label),
    h(SelectField, { size: 'md', 'aria-label': label, value: form[key], onChange: e => setForm({ ...form, [key]: e.target.value }) },
      options.map(([id, text]) => h('option', { key: id, value: id }, text))),
  )
  return h('div', { className: PANE, 'data-settings-pane': 'agents' },
    h('div', { className: SECTION },
      h('div', { className: SECTION_TITLE }, '自动派单（专家 agent）'),
      h('div', { className: FIELD },
        h('label', { className: CHECK_ROW },
          h(CheckField, { checked: form.agentsEnabled, onChange: e => setForm({ ...form, agentsEnabled: e.target.checked }) }),
          h('span', {}, '卡片进入勾选的列时，自动派给该列的负责人'),
        ),
        h('div', { className: HINT }, '关闭后仍可在卡片抽屉里点「马上处理」手动派单；派单结果会写回评论并推进卡片。'),
      ),
      h('div', { className: FIELD },
        h('div', { className: LABEL }, '哪些列自动派单'),
        h('div', { className: CHECK_GROUP },
          [['design', '待方案'], ['dev_ready', '待开发'], ['dev', '开发中'], ['test', '待测试']].map(([id, label]) =>
            h('label', { className: CHECK_ROW, key: id },
              h(CheckField, { checked: form.agentsAuto.includes(id),
                onChange: e => setForm({
                  ...form,
                  agentsAuto: e.target.checked
                    ? [...form.agentsAuto, id]
                    : form.agentsAuto.filter(entry => entry !== id),
                }),
              }),
              h('span', {}, label),
            )),
        ),
        h('div', { className: HINT }, '勾选的列在卡片进入时自动派给该列对应的负责人；其余列只能手动「马上处理」。'),
      ),
      field('agentsMaxConcurrent', '同时最多几个 agent', '2'),
      field('agentsPreset', 'Agent 预设', 'standard'),
      h('div', { className: HINT }, '预设决定 agent 手里有哪些工具：standard 带 shell 与文件读写，minimal 只有基础工具。'),
      field('agentsWorkspace', '兜底工作目录', '~/dsh-workspace'),
      h('div', { className: HINT }, '卡挂在配了「本机代码目录」的项目上时，派单会话跑在那个仓库里 —— 它才会出现在侧栏的项目工作区下；项目没配代码目录时才用这个兜底目录。'),
      selectOf('沙箱档位（这个会话能写哪、能跑什么）', 'agentsSandbox', [
        ['read-only', '只读：能看不能改'],
        ['workspace-write', '只写工作区（推荐）：能改自己的目录，改不到系统别处'],
        ['danger-full-access', '无沙箱：可以写任何地方（危险）'],
      ]),
      h('div', { className: HINT }, '由 DSH 的 permission preset 执行：read-only / workspace-write 走 bwrap 或 Landlock 隔离。单个专家可以在「专家」里覆盖。'),
      selectOf('派单会话的提权审批', 'agentsEscalation', [
        ['allow', '自动批准（推荐）：需要提权就放行，等于始终允许完全访问'],
        ['deny', '自动拒绝：只做沙箱允许的事，被拒的写进卡上评论'],
      ]),
      h('div', { className: HINT }, '派单是无人值守的：DSH 弹出审批时没有人在点。选「自动批准」就不会再问、也不会卡住（每次放行都会写一条卡上评论留痕）；沙箱选「只读」时一律拒绝。'),
      selectOf('代码隔离', 'agentsIsolation', [
        ['none', '不隔离：所有卡共用一个工作区'],
        ['worktree', '一卡一个 git worktree（推荐给多卡并行）'],
      ]),
      h('div', { className: HINT }, '开启后，卡要挂在配了「本机代码目录」的项目上，派单时会为它切一条 task/<编号> 分支。'),
      selectOf('工作区分组', 'agentsGrouping', [
        ['card', '一卡一个文件夹：每张卡独立 worktree（默认）'],
        ['requirement', '一个需求一个文件夹：产品/架构/测试共用需求 worktree；同需求多张研发卡并发时仍各自 worktree 隔离'],
      ]),
      h('div', { className: HINT }, 'DSH 的工作区按会话 cwd 精确归属：一个文件夹只能挂 cwd 相同的会话。选「按需求」后，同一需求的产品/架构/测试会话会落在同一个侧栏文件夹里。'),
      field('agentsWorktreeRoot', 'worktree 根目录', '留空 = 仓库内 .agents/worktrees'),
      h('div', { className: HINT }, '留空时 worktree 建在仓库的 .agents/worktrees 下，侧栏里挂在项目工作区下；项目没配代码目录时退回工作区同级的 dsh-worktrees。'),
      selectOf('卡完成时', 'agentsCleanup', [
        ['manual', '保留 worktree 和分支，等人看 diff'],
        ['on_done', '自动删掉 worktree 和分支'],
      ]),
    ),
    saveBar,
  )
}
