/* 设置页里仍内联在 client.src.js 的三块面板：看板外观 / 角色与模型 / 自动派单。
 *
 * 迁出来只换表现层（BoardUI token + 4px 档位），表单值、保存流程、字段顺序与选项都不变：
 *   · 分区 = 卡片（rounded-xl + border-separator-border + bg-background-primary-default + p-4）；
 *   · 字段 = 标签（caption）+ 控件，控件仍走共享的 TextField / SelectField / CheckField；
 *   · 动作走 BoardUI Button；保存结果用 token 色的小字。
 *
 * 这三块原先挂在旧 panel 的「壳 / 头 / 体」三层类上，是设置页外壳迁完后的最后一批。
 */
import { Button } from '../../boardui/index'
import { ROLE_LABEL } from '../labels.js'
import { client } from '../context.js'

const PANE = 'flex min-w-0 flex-col gap-4'
const SECTION = 'flex min-w-0 flex-col gap-4 rounded-xl border border-separator-border bg-background-primary-default p-4'
const SECTION_TITLE = 'text-title-2-semibold text-text-primary'
const FIELD = 'flex min-w-0 flex-col gap-1'
const LABEL = 'text-caption-2-medium text-text-secondary'
const HINT = 'text-caption-1-regular text-text-tertiary'
const ERR = 'text-caption-1-regular text-text-error-primary'
const OK = 'text-caption-1-regular text-state-success-text'
const GRID2 = 'grid grid-cols-1 gap-4 md:grid-cols-2'
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

/** 保存条：主按钮 + 结果/错误小字（原来复用同一个 saveBar 节点，这里保持节点语义）。 */
export function SettingsSaveBar({ busy, status, error, onSave }) {
  const { h } = client()
  return h('div', { className: ROW, 'data-settings-savebar': '' },
    h(Button, { variant: 'primary', size: 'sm', 'data-action': 'save', disabled: busy, onClick: () => void onSave() }, busy ? '保存中…' : '保存'),
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

/** 角色与模型：每个角色位一行模型名（两列，窄屏一列）。 */
export function RoleModelsPane({ form, setForm, saveBar, roleKeys }) {
  const { h, TextField } = client()
  return h('div', { className: PANE, 'data-settings-pane': 'models' },
    h('div', { className: SECTION },
      h('div', { className: SECTION_TITLE }, '角色与模型'),
      h('div', { className: GRID2 },
        roleKeys.map(role => h('div', { className: FIELD, key: role },
          h('div', { className: LABEL }, `${ROLE_LABEL[role] ?? role}`),
          h(TextField, {
            'aria-label': `${ROLE_LABEL[role] ?? role}的模型`,
            value: form.roles[role].model,
            placeholder: 'deepseek-v4.1-flash',
            onChange: e => setForm({ ...form, roles: { ...form.roles, [role]: { ...form.roles[role], model: e.target.value } } }),
          }),
        )),
      ),
    ),
    h('div', { className: HINT }, '单个专家可以在「专家」里单独指定模型，优先级：专家模型 → 这里的角色模型 → 宿主默认。'),
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
      selectOf('代码隔离', 'agentsIsolation', [
        ['none', '不隔离：所有卡共用一个工作区'],
        ['worktree', '一卡一个 git worktree（推荐给多卡并行）'],
      ]),
      h('div', { className: HINT }, '开启后，卡要挂在配了「本机代码目录」的项目上，派单时会为它切一条 task/<编号> 分支。'),
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
