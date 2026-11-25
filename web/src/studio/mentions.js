/* 卡片抽屉评论框里的 @ 选择面板。
 *
 * 外观按参考稿：宽约 340 的弹层，顶部「专家 / 专家团」两段式页签，下面是搜索框，
 * 再往下是按分组（角色位 / 专家 / 专家团）列的清单，每行「头像 + 名字 + 一行说明」。
 *
 * 位置：正常流内、紧贴输入框上方（以前用 position:absolute + bottom:100% 锚不到定位祖先，
 * 整块被顶到视口外，打 @ 什么都看不见）。
 */

import { SegmentedControl } from '../boardui/index'
import { uiIcon } from './icons.js'
import { filterRoster } from './roster.js'

/* unslop 口径：间距只用 4/8/12/16，圆角只用 8/16，阴影只有一枚中性软阴影，图形符号一律线性图标。 */
const POP = 'flex w-full max-w-[344px] flex-col overflow-hidden rounded-2xl border border-separator-border bg-background-primary-default shadow-lg'
const TABS = 'flex shrink-0 items-center gap-1 rounded-lg bg-background-secondary-default p-1'
const TABS_WRAP = 'shrink-0 border-b border-separator-border p-2'
const TAB_ON = 'flex-1 rounded-md bg-background-primary-default px-3 py-1 text-caption-1-medium text-text-primary shadow-sm'
const TAB_OFF = 'flex-1 rounded-md px-3 py-1 text-caption-1-medium text-text-tertiary'
const GROUP = 'sticky top-0 z-10 bg-background-primary-default px-5 pb-1 pt-3 text-caption-2-medium text-text-tertiary'
const ITEM = 'flex h-10 w-full cursor-pointer items-center gap-2 px-5 text-left text-body-2-regular text-text-primary hover:bg-background-secondary-default data-[active="1"]:bg-background-secondary-default'
const AVATAR = 'flex size-7 flex-none items-center justify-center rounded-full'
/* 参考稿的头像是彩色圆形底。它的颜色按「角色」分：产品紫 / 架构蓝 / 研发绿 / 测试橙 / 团灰。
   用内联 hsl 而不是 Tailwind 调色板类——后者要看主题里有没有那几个 scale，缺了就是白底。 */
const TONE = {
  product: ['hsl(258 70% 95%)', 'hsl(258 55% 48%)'],
  architect: ['hsl(214 80% 94%)', 'hsl(214 65% 46%)'],
  dev: ['hsl(160 55% 92%)', 'hsl(160 55% 34%)'],
  qa: ['hsl(32 90% 93%)', 'hsl(28 75% 45%)'],
  team: ['hsl(220 14% 93%)', 'hsl(220 12% 40%)'],
}
const roleOf = item => {
  const key = String(item.key ?? '')
  if (key === 'r:product' || key === 'r:architect' || key === 'r:dev' || key === 'r:qa') return key.slice(2)
  if (item.group === '专家团') return 'team'
  const icon = String(item.icon ?? '')
  if (icon === 'expertProduct') return 'product'
  if (icon === 'expertArchitect') return 'architect'
  if (icon === 'expertDev') return 'dev'
  if (icon === 'expertQa') return 'qa'
  return 'team'
}
const HINT = 'block truncate text-caption-2-regular text-text-tertiary'
const EMPTY = 'px-3 py-4 text-caption-1-regular text-text-tertiary'

export function createMentionPicker({ h, React, TextField, SearchField }) {
  function MentionPicker({ roster, query, active, onQuery, onActive, onPick, onClose }) {
    const [tab, setTab] = React.useState('expert')
    /* 页签决定看哪一类：专家页签含「角色位」（按角色派单的兜底），专家团页签只看团。 */
    /* 只要专家（和团）。「角色位」是给 AI 按角色派单的兜底，人挑的时候用不上，反而把名单撑长。 */
    const inTab = item => (item.group === '专家团' ? tab === 'team' : item.group === '专家' && tab === 'expert')
    const hits = filterRoster(roster, query).filter(inTab)
    const move = delta => {
      if (hits.length === 0) return
      onActive((active + delta + hits.length) % hits.length)
    }
    const onKeyDown = event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
      else if (event.key === 'Enter') { event.preventDefault(); if (hits[active] !== undefined) onPick(hits[active].name) }
      else if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    return h('div', {
      className: POP,
      'data-mention-pop': '',
      style: { position: 'relative', zIndex: 5, margin: '8px 12px' },
      onKeyDown,
    },
      h('div', { className: TABS_WRAP, 'data-mention-tabs': '' },
        h(SegmentedControl, {
          value: tab,
          onChange: next => { setTab(next); onActive(0) },
          options: [{ value: 'expert', label: '专家' }, { value: 'team', label: '专家团' }],
          'data-mention-tab': 'expert',
        }),
      ),
      h('div', { className: 'shrink-0 border-b border-separator-border p-3' },
        h('div', { className: 'flex items-center gap-2 rounded-lg border border-separator-border bg-background-primary-default px-3' },
        uiIcon(h, 'search') ?? null,
        h(SearchField ?? TextField, {
          autoFocus: true, value: query,
          placeholder: '搜名字、领域或关键词',
          onChange: event => onQuery(event.target.value),
          onFocus: () => onQuery(query),
          'data-mention-search': '',
        }),
        ),
      ),
      h('div', { className: 'max-h-[260px] overflow-y-auto py-1', 'data-mention-list': '' },
        hits.length === 0
          ? h('div', { className: EMPTY, 'data-mention-empty': '' }, tab === 'team' ? '没有匹配的专家团' : '没有匹配的专家')
          : hits.map((item, index) => {
            const first = index === 0 || hits[index - 1].group !== item.group
            return [
              first ? h('div', { key: `g-${item.group}`, className: GROUP }, item.group) : null,
              h('button', {
                key: item.key, type: 'button', className: ITEM, 'data-mention-item': '', 'data-active': index === active ? '1' : '0',
                /* 宿主的按钮重置会把 padding 清零，类名压不住——这里写行内，保证左右 20px。 */
                style: { paddingLeft: 20, paddingRight: 20 },
                title: item.hint,
                onMouseEnter: () => onActive(index),
                onClick: () => onPick(item.name),
              },
              h('span', {
                className: AVATAR,
                style: { background: TONE[roleOf(item)][0], color: TONE[roleOf(item)][1] },
              }, uiIcon(h, item.icon) ?? (item.name ?? '?').slice(0, 1)),
              h('span', { className: 'min-w-0 flex-1 truncate text-body-2-regular text-text-primary' }, item.name)),
            ]
          }).flat().filter(Boolean),
      ),
    )
  }
  return MentionPicker
}
