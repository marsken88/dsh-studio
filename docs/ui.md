# 界面：样式与构建链
- **全面转 BoardUI**（2026-11-23）：基线定为 BoardUI（`web/src/components/base/**` + `web/src/boardui/**`），
  手写 `.ds-*` 逐块迁完即删，不再反向映射。
- **迁移收尾**（0.9.76）：CSS 里的手写类 124 → **14**（`client.src.js` −233 行、`index.css` −1026 行），
  `main.jsx` 的四条 legacy 桥删除，产物 1,391 → 1,324 kB。
  剩余的 14 个：Markdown 排版作用域（已改名 `md-content*`）、overlay 测试断言的覆盖层类、三个仍在渲染的组件钩子
  （`ds-dot` / `ds-icon` / `ds-seg-control`）。清理器 `tools/ui/prune-ds-css.mjs` 改成按规则块删。
- **迁移收官**（0.9.75）：`client.src.js` 的顶栏、页签、看板页外壳、三个内联设置面板、
  新建任务对话框、市场页、登录卡全部换 BoardUI；代码段手写类 222 → 23，全仓 3364 → 188。
  新增 `web/src/studio/panels/settings-panes.js` 与 `web/src/studio/dialogs/new-task.js`。
  剩余 `.ds-*` 只剩三类：`ds-md*`（Markdown 排版作用域）、overlay 测试断言的四个覆盖层类、
  以及探针锚点/看板兜底样式。
- **第一批大会战完成**（0.9.74）：抽屉（495→0）、五个页面（804→0）、看板与周边（104→0）、
  四个设置面板（751→0）、设置页外壳。全仓手写类 3364 → 856，剩余集中在 `client.src.js`
  （顶栏 / 页签 / 看板外壳 + 14 个仍内联的设置面板）。
  探针判据同步改成 `data-*` 钩子（类名是样式实现，不该当判据）；新增 `tools/ui/prune-ds-css.mjs`
  （带 `NEVER_DELETE` 白名单）负责「迁一块删一块」。
  `ds-md*` 必须保留：Markdown 排版作用域还没有 BoardUI 等价物。
  项目页是这套写法的样板：卡片 `rounded-xl + border-separator-border + bg-background-primary-default`、
  数字 `text-title-2-semibold`、进度条 `ProgressTrack`、空态 `boardui/empty-state`、动作 `boardui/index` 的 Button。
- **shadcn 全部退场**（2026-11-20）：`components/ui.jsx` 删除，`studio-ui.jsx` 的五个再导出改走 BoardUI，
  `login-gate.jsx` 的 Card/Tabs/Label/Button 换成 BoardUI（PillTab 切登录方式）。同时删掉 10 个无引用的
  `@radix-ui/*`。产物 1,453 → 1,368 kB，构建守卫的 Radix 门户计数 2 → 0。
  **新组件一律从 `web/src/components/base/**`（BoardUI 源码）或 `web/src/boardui/**`（自研补位）取，不要再引入 Radix。**
- **设置页左栏跟随页签语言**（2026-11-20）：左栏原来用「实心强调色 + 白字」，与顶部 shadcn 页签的
  「灰底轨道 + 选中浮起」两套视觉。现改为同一套：轨道 `color-mix(前景 6%, 背景)`、选中项 `--card` + `--ds-shadow`、
  未选中 `--muted-foreground`。**这类规则要写在 `web/src/index.css`（带 `!important`）**——构建会压平 legacy 里的 `[data-dsh-studio]` 前缀并合并同名规则；
  而 `client.src.js` 有「只许变小」的棘轮，别往里加样式。

从 README 拆出来的界面实现记录。要看界面长什么样，回 [README](../README.md) 看图。

## 样式对齐 shadcn/ui（2026-11-09）

参考 <https://ui.shadcn.com/> 的默认主题（zinc / neutral），把整套界面换成它的视觉语言。
**没有引入 Tailwind，也没有加构建步骤**——仍然是一个 `client.js`，在原有 `<style>` 末尾追加
一层「token + 组件规则」，用同名变量覆盖旧样式，所以不会破坏既有功能。

### 为什么不是直接装 shadcn 组件

shadcn 是「把 React + Tailwind 源码拷进项目」的分发方式，需要构建管线（Tailwind 编译、
tsconfig 路径别名、Radix 依赖）。这个插件是宿主里的单文件 bundle（`window.__ModuleLoader__`
+ `React.createElement`），加构建会破坏现在的零依赖部署方式。因此这里对齐的是**设计系统本身**：
同一套 CSS 变量名、同一套圆角/描边/阴影/焦点环尺度、同样的组件外观。

### Token

```css
[data-dsh-studio][data-theme="light"] {
  --background:#fafafa; --foreground:#09090b;
  --card:#ffffff;       --primary:#18181b; --primary-foreground:#fafafa;
  --secondary:#f4f4f5;  --muted:#f4f4f5;  --muted-foreground:#71717a;
  --destructive:#dc2626; --border:#e4e4e7; --input:#e4e4e7; --ring:#a1a1aa;
}
[data-dsh-studio][data-theme="dark"] {
  --background:#09090b; --foreground:#fafafa;
  --card:#111113;       --primary:#fafafa; --primary-foreground:#18181b;
  --secondary:#1b1b1f;  --muted:#1b1b1f;  --muted-foreground:#a1a1aa;
  --destructive:#ef4444; --border:#27272a; --input:#27272a; --ring:#52525b;
}
```

旧的 `--ds-*` 变量保留，但都指向新 token（`--ds-bg→--background`、`--ds-surface→--card`、
`--ds-surface-2→--muted`、`--ds-line→--border`、`--ds-accent→--primary`、`--ds-shadow`），
所以几百处既有样式不用改。统一圆角 `--radius:10px`。

### 逐项检查过的组件

| 组件 | 处理 |
| --- | --- |
| 按钮 `.ds-btn` | shadcn `Button` 默认档：32px 高、12px 内边距、1px `--input` 描边、`--card` 底、`--muted` hover、圆角 10、`--ds-shadow` |
| 主按钮 `.ds-btn-primary` | `bg-primary + text-primary-foreground`（浅色近黑、深色近白） |
| 幽灵按钮 `.ds-btn-ghost` | 透明底、hover 出 `--muted`，用于「退出登录 / 导出」 |
| 输入框 `.ds-input/.ds-select/.ds-textarea` | 1px `--input`、32px 高、hover 变 `--ring`、focus 出 `0 0 0 3px ring/35%` 光晕 |
| 卡片/面板 `.ds-panel/.ds-card/.ds-kpi` | `--card` 底 + 1px `--border` + `--ds-shadow`，圆角 12 |
| 徽标 `.ds-chip` | 21px 高胶囊，`--secondary` 底 + `--border`，语义色（缺陷/超时/通过）保留色相 |
| 页签 `.ds-tabs/.ds-tab` | shadcn `Tabs` 胶囊：`--muted` 容器，选中项 `--card` + 阴影 |
| 分段控件 `.ds-seg` | 同款胶囊，用于主题三档与登录方式切换 |
| 看板 `.ds-col/.ds-card` | 列底 `--muted` + 描边；卡片白底、13px 标题、11px 元信息 |
| 抽屉/弹窗 `.ds-side/.ds-drawer/.ds-modal` | `--card` 底、1px 描边、大阴影、遮罩 `rgb(9 9 11 / .5)` |
| 表格化行 `.ds-listrow/.ds-doc-row/.ds-audit-row` | 行间 1px `--border`，hover 出 `--muted` |
| 登录卡 | `Card` 同款：描边 + 20px 阴影 + 圆角 14 |
| 焦点环 | 全局 `:focus-visible` → `2px solid --ring`，offset 2（键盘可达性那层仍然生效） |
| 滚动条 | 拇指用 `foreground 20%/32%` 透明色，两套主题都可见 |

### 验证

- 浅色：工作台（KPI、分区、清单）、看板（列/卡片/徽标）、项目卡、设置-专家列表逐一截图核对。
- 深色：截图整页平均亮度 **23.2**（浅色约 **246**），卡片/描边/文字在 `#09090b` 上可读。
- 登录页、抽屉、表单沿用同一套 token，未单独写样式分支。

## 构建链：真实 shadcn/ui（2026-11-09）

前面几版是「手写一套 shadcn 风格 CSS」。现在 `dsh-studio/web/` 是一个真正的 Vite + Tailwind + Radix 工程，组件按 shadcn 官网源码 vendored 进来。

### 为什么需要构建，以及为什么要桥接

- 宿主只提供 `window.__ModuleLoader__.load({ id, factory })` 这个入口，`factory` 里 `require('react')` 拿到的是**宿主的 React**。
- shadcn/Radix 需要 React 18 的 hooks dispatcher，且组件在自己的树里跑；两棵 React 树不能共享渲染。
- 所以：React 打进插件自己的 bundle，宿主那边只渲染一个**类组件桥**（`web/src/bridge.jsx`，无 hooks），桥里用一个 `div`（`display:contents`）承载我们自己的 `createRoot`。两棵树互不干扰，元素对象靠 `Symbol.for('react.element')` 互通。

### 目录

| 路径 | 作用 |
| --- | --- |
| `web/vite.config.mjs` | IIFE、单文件 `../dist/client.js`、`cssCodeSplit:false`、`inlineDynamicImports` |
| `web/tailwind.config.js` | `corePlugins.preflight=false`（CSS 会注入宿主页面，不能带全局 reset）、`darkMode:['selector','[data-theme="dark"]']`、颜色映射到 shadcn 的 HSL 变量 |
| `web/src/index.css` | shadcn token（浅/深两套），作用域限定在 `[data-dsh-studio]` 与 `[data-dsh-studio-portal]`（Radix 浮层会被传送到 `<body>`） |
| `web/src/components/ui.jsx` | vendored 原子组件：Button/Input/Textarea/Label/Card/Badge/Tabs/Dialog/Switch/Checkbox |
| `web/src/components/login-gate.jsx` | 第一个真正替换的界面：登录卡片（Card + Tabs + Input + Button） |
| `web/src/bridge.jsx` | 宿主 React ↔ 自带 React 的类组件桥 |
| `web/src/main.jsx` | 入口：注入 Tailwind CSS、注册 `window.__ModuleLoader__.load` |
| `web/scripts/make-legacy.mjs` | 把 `dsh-studio/client.src.js`（手写源码）转成 `web/src/legacy.js`（去掉 loader 包装，导出 `createStudio(React, h)`） |
| `web/scripts/sync-client.mjs` | 构建后把 `dist/client.js` 复制回包根的 `client.js`，保证「仓库里的 `client.js` = 线上实际加载的那份」 |

### 构建与部署

```bash
cd dsh-studio/web
pnpm install          # pnpm 10 默认拦 esbuild 的构建脚本，首次可能提示 approve-builds
pnpm build            # make-legacy → vite build → sync-client，一次跑完
```

三个文件的关系：

| 文件 | 是什么 | 谁读它 |
| --- | --- | --- |
| `client.src.js` | 手写的单文件源码（约 520 KB，前端逻辑全量实现） | 构建第一步 `make-legacy.mjs` 读它生成 `web/src/legacy.js` |
| `dist/client.js` | Vite 产物：单文件 IIFE，React 与 CSS 都打进（约 696 KB / gzip 207 KB） | 部署时上传它就是根目录 `client.js` 的来源 |
| `client.js`（包根） | 构建产物的副本，由 `sync-client.mjs` 写出 | DSH 按 `package.json` 的 `./client` 导出加载它 |

所以：**只改前端逻辑 → 改 `client.src.js`；改样式/组件 → 改 `web/src/**`**；两边都要在 `web/` 里跑一次 `pnpm build`，根目录 `client.js` 会自动同步，然后提交。

部署到另一台机器只需要 `index.js` + `dist/client.js` + 整个 `src/host`：用 `node tools/deploy.mjs`（目标机、账号从环境变量传，脚本会备份、自检、`active` 不对就非零退出），具体命令见 `docs/quickstart.md`。

### 已验证

- 构建产物 `526 kB`（gzip 161 kB），单文件、无独立 CSS 资源。
- Chrome 实测：刷新后登录卡是新组件（胶囊页签 + 圆角输入框 + 黑色主按钮），切「本地超管」后直接打字即可，`admin`/`admin` 登录进入工作台，主题切换与看板正常。
﻿
---

## 对话框与列表行（2026-11-10）

原生 `window.confirm` / `window.prompt` 已全部换成 shadcn 风格的 Radix Dialog，23 处调用点（删除卡/需求/版本/专家/专家团/环境/项目/仓库/机器人/技能/文档/功能点、市场移除、插件装卸、清空审计、快照回滚、worktree 回收、标记阻塞、改领域、强制发布、回滚原因、评审打回）。

- `web/src/components/studio-ui.jsx` 的 `DialogBox({ open, title, message, danger, okText, cancelText, input, value, placeholder, onChange, onOk, onCancel })`：标题 + 说明 + 「取消 / 确定」，`danger` 时确定按钮用破坏色，`input` 为真时带 3 行文本域（用于「强制发布原因」「回滚原因」这类需要写理由的场合）。
- `client.js` 的 `confirmDialog(message, options)` / `promptDialog(message, options)` 返回 Promise，`DialogHost` 挂在工作区根节点上；没有 UIKIT 时自动回落原生弹窗，保证纯单文件产物仍可用。
- 列表行统一：`.ds-listrow` 内按钮 26px 高、幽灵按钮 hover 才显形；`[data-danger="1"]` 的按钮红字 + 淡红 hover；`.ds-audit-row` 行高 7/14；窄屏（≤900px）缩小 spark 日期字号、≤760px 隔天显示，避免 14 个标签挤成一排。

### 中窄屏顶栏与代码分割（2026-11-21）

- 761–920px 时顶栏动作区（新建 / 刷新 / 运行托盘 / 当前用户）约 600px，一行放不下会把标题挤到只剩几十像素。`@media (max-width:920px)` 让 `.ds-head-top` / `.ds-head-actions` 换行：800px 实测标题独占一行、动作区第二行，无横向溢出；`pages-probe` 在 1600px 跑完后切 800px 再验一次（无横向溢出 + 动作区换行）；同时每页检查「可聚焦却被 aria-hidden 藏起来」的节点。
- **不做代码分割**：`web/vite.config.mjs` 的 `inlineDynamicImports` + `cssCodeSplit:false` 是 DSH 单文件插件的加载约定（`window.__ModuleLoader__` 只取一个 `client.js`）。拆 chunk 会让部署与加载找不到资源；要减体积只能删依赖或把非首屏逻辑做成运行时懒加载，不能靠 Rollup 拆包。

### 踩过的坑：Radix 门户跑出作用域

Tailwind 产物被 `web/scripts/scope-css.mjs` 改写成 `[data-dsh-studio] .fixed …`；而 Radix 的 Portal 默认挂到 `document.body`，门户里的元素不在这个子树里，定位类全部失效，弹窗会掉到页面末尾变成一段普通文本流（UIA 能读到文字、肉眼看不见）。

修法两处：① 作用域插件同时产出 `[data-dsh-studio-portal] …` 前缀；② `studio-ui.jsx` 提供 `portalRoot()` 懒创建一个带 `data-dsh-studio-portal` + `data-theme` 的容器，四个 Portal（Dialog ×2、Select、Tooltip）都用 `container={portalRoot()}` 挂进去，明暗主题随工作区同步。
﻿
---

## 布局与 Markdown 一致性（2026-11-10）

这一轮修的是「看起来哪里都不对」的根因，而不是逐个页面调参数。

### 1. 同名 CSS token 被两种格式覆盖
- `web/src/index.css` 里 shadcn token 原本是 HSL 三元组（`--border: 240 6% 90%`），约定 `hsl(var(--x))`；
  legacy `client.js` 又把同名变量定义成 hex（`--border:#e4e4e7`），特异性更高、注入更晚。
- 结果：所有 `hsl(var(--x))` 变成 `hsl(#e4e4e7)`，声明非法被丢弃 —— 列底色透明、卡片描边消失、按钮没底色。
- 修法：**全站统一为 hex + 裸 `var(--x)`**。`tailwind.config.js` 19 处、`index.css` 92 处、`client.js` 1 处；
  `hsl(var(--x) / a)` 改写成 `color-mix(in srgb, var(--x) N%, transparent)`。判断依据是页面内
  `getComputedStyle(el).getPropertyValue('--border')` 返回的是 `#e4e4e7` 而不是三元组。

### 2. `.ds-row` / `.ds-field` 只有 min-width，没有 display
- 全站 97 处 `ds-row`、151 处 `ds-field`，布局原本靠行内 `style={{ gap, alignItems, flex }}`；
  但 CSS 里这两个类只有 `min-width:0`，于是它们退化成块级堆叠 —— 专家编辑里标签和控件互相压住。
- 修法（`index.css`）：
  `[data-dsh-studio] .ds-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}`、
  `[data-dsh-studio] .ds-field{display:flex;flex-direction:column;gap:5px;min-width:0}`、
  `.ds-row > .ds-field{flex:1 1 220px}`；字段内的 `.ds-hint` 取消 `margin-left:auto`。

### 3. uiKit 缺 Input / Textarea，多行输入只剩 32px
- `web/src/main.jsx` 的 `uiKit` 只注入了 SheetDrawer/TabsBar/SelectBox/SwitchBox/Tip/ProgressBar/DialogBox/Badge，
  `kit('Input')`、`kit('Textarea')` 全是 null → 112 处 TextField、14 处 TextAreaField 回落成原生控件。
- 原生 textarea 又被表单 reset 清了 padding，`rows=9` 实测只有 32px 高（角色提示词框就是这个）。
- 修法：uiKit 补 `Input, Textarea, Label`；`TextAreaField` 不再丢弃调用方 className，
  并按 `rows` 计算 `minHeight = max(84, rows*21+26)`（9 行 → 215px）。

### 4. Markdown：输入处给预览，展示处统一渲染
- 新增 `MdField`（`client.js`，在 `tipLabel` 之前）：工具行「支持 Markdown：标题 / 列表 / 粗体 / 代码块 / 表格」+
  「预览渲染 / 回到编辑」切换，预览复用 `renderMarkdown()`。
- 换用位置：需求正文、文档正文、交付物正文、技能正文、任务需求/背景、功能点说明、发布说明。
- 展示处保持渲染 Markdown 的：需求明细、功能点说明、评论、发布说明（复制前可预览）。
- 验收方式：无头 Chrome 打开「需求 → 编辑」，`.ds-md-bar` 存在、textarea 219px、点「预览渲染」后
  `.ds-md-preview` 出现且 `li` 数量与原文条目一致。

### 5. 看板列与滚轮
- `.ds-col` 实色底 + 1px 描边 + `scroll-snap-align:start`；`.ds-col-head` 卡片底色；`.ds-card{min-width:0;max-width:100%}`。
- 滚轮改原生 `{ passive:false }` 监听（React 的 onWheel 在 root 上是 passive，`preventDefault` 无效），
  命中 `.ds-board` 时把 `deltaY` 转成 `scrollLeft`。
﻿

## 直接阅读与暗色巡检（2026-11-10）

### A. 交付物 / 文档正文可直接展开阅读

- 交付物：`artRead` 状态记「当前展开的交付物 id」，行按钮「阅读 / 收起」；展开区 `.ds-md-preview.ds-reader`（`max-height:360px; overflow:auto`）用 `renderMarkdown(content)` 渲染，空正文提示「这条交付物还没有正文。」
- 文档：`docReader` 状态 + `readDoc(docId)`——点「阅读」时按需 `POST /studio-api/requirement/get` 取回完整 `docs[]`（列表接口只给 `contentLength`），再渲染 Markdown；读取中显示「读取中…」，空正文提示「这条文档还没有正文。」；再点「收起」关闭。
- 实测：TEST-002 卡片 → 交付物 → 阅读，`.ds-reader` 高 360、65 个块；需求 `REQ-2026-001` → 文档 → 阅读，`.ds-reader` 高 235、5 个块、正文以「会员积分抵扣背景…」开头。

### B. 暗色逐页巡检（明亮 + 黑暗各一遍）

- 巡检方式：`tools/visual/probe-dark-sweep.mjs`（headless Chrome 登录 → 挂载面板 → 逐页签截图 + 采集 `getComputedStyle`），截图落在 `tmp/dark-*.png` / `tmp/dark2-*.png`。
- 修复：看板工具栏 `.ds-board-bar` 之前被压成 `padding: 0 0 10px`，第一个搜索框紧贴面板左边缘、看着像被裁掉；改成 `padding: 12px 20px 10px; border-bottom: 1px solid var(--border)`，与看板列的 20px 内边距对齐，工具行与内容之间也有分隔线。
- 复核：看板（列底 `--muted`、列头 `--card`、卡片描边与文字 `rgb(230,232,238)`）、版本（面板/操作区/发布按钮）、效能（KPI 卡、柱状与日期轴、燃尽折线）、项目（整行卡片、统计框、服务行 chip）、市场（专家卡与角色 chip、空态虚线框）、需求（评审、矩阵、文档、变更影响）六页在暗色下均无白底突兀、无不可读文字。
- 已知边界：无头 Chrome 未装 emoji 字体，截图里 📎 ✅ 之类的图标会显示成空心方块，这不是页面问题。


## 换骨：把 BoardUI 的组件源码真接进来（2026-11-17）

不是照着图重画，是把 [BoardUI](https://www.boardui.com/zh-hans/installation) 的**源码文件原样复制**进仓库，再让我们的调用点去用它。
免费组件 MIT（保留头注释），Pro 组件不买，需要的话自己实现等价物。

### 通道
- 源码落在 `web/src/components/base/**`（`buttons/`、`input/`、`textarea/`、`checkbox/`），一行没改；
  `web/src/utils/{cx,directional-icon}.ts` 是它们的工具依赖，同样原样。
- `web/vite.config.mjs` 加了 `@ -> web/src` 别名，esbuild/vite 直接吃 `.tsx`，不需要 tsconfig。
- Tailwind v4（`@tailwindcss/postcss`）+ `web/src/boardui/theme.css` 的 315 个 token 提供它们的视觉变量；
  preflight 保持关闭，`web/scripts/scope-css.mjs` 把所有选择器改写进 `[data-dsh-studio]`。

### 适配层（`web/src/boardui/index.tsx`）
调用点一行不改，语义翻译都在这层：
- `Button`：`default→primary`、`secondary→secondary`、`outline→secondary`、`ghost→ghost`、`destructive→danger`、`link→ghost`；
  尺寸 `default/lg→medium`、`sm→small`、`xs→xs`、`icon→medium`。
- `Input` / `Textarea`：`value` / `onChange(e.target.value)` 的 DOM 语义 → react-aria 的 `value` / `onChange(string)`；
  `disabled / readOnly / required` → `isDisabled / isReadOnly / isRequired`；
  调用方传的 `ds-input` / `ds-textarea` 这类 legacy 类名被过滤掉（视觉由 BoardUI 的壳子负责），`style` 挂到字段根节点。
- `Checkbox`：`checked` + `onChange(e.target.checked)` → `isSelected` + `onChange(boolean)`。
- 没给 `aria-label` 时用 `placeholder` 兜底，避免 react-aria 报「字段没有可访问名」。

### 已换到源码组件的
| 调用点 | 用的源码 |
| --- | --- |
| `components/ui.jsx` 的 `Button`（全站按钮） | `base/buttons/button.tsx` |
| `studio/fields.js` 的 `TextField`（看板搜索、抽屉表单、设置页） | `base/input/input.tsx`（`TextField` + `InputBase`） |
| `studio/fields.js` 的 `TextAreaField`（评论、需求正文、角色提示词） | `base/textarea/textarea.tsx` |
| `studio/fields.js` 的 `CheckField`（看板筛选、自动派单、权限开关） | `base/checkbox/checkbox.tsx` |

**还没换**：`SelectField`（仍是 Radix `SelectBox`）、Tabs、Drawer、Modal、Table —— 下一批。

### 验证
- `npm run verify:fields`（新）：真 Chrome 打字 / 勾选 / 清空 / 读回值，15 项全过 —— 关键是「受控回写没断」：
  输入「超时」后卡片只剩 1 张且 `input.value` 还是「超时」，勾上「隐藏空列」后列数 8→2 且 glyph 变色。
- `verify:facts` 5/5、`verify:costs` 7/7、`verify:scale` 9/9、`npm test` 108/108，`pageerror` 全程为空。
- 体积：857.71 kB → **914.85 kB**（gzip 242.33 → 261.05）。涨的部分是 react-aria 的 textfield / checkbox
  真正进包了（之前只是裸 import，被 tree-shake 掉了）。

### 踩过的坑
- 组件之间有同目录兄弟依赖（`input` 要 `label` / `hint-text`，`checkbox` 要 `checkbox-glyph`，`textarea` 还要
  `@/components/base/input/*`），少一个就红构建 —— 扫 `@/` 与相对 import 补齐，别手写。
- react-aria 的 `Checkbox` 根节点是 `<label>`，`role=checkbox` 在那个视觉隐藏的 `input` 上；
  自绘的 16px 方块是 `span[aria-hidden]`，选中态靠 `shadow-checkbox-selected` 这个类。
- `type=date` 仍然是原生 input（react-aria 的 `useTextField` 不做日期格式化，那是 `useDateField`），
  包进 BoardUI 的壳子后行为与以前一致。

### 第二批：Select（下拉）

- 源码来源改成**直接从 GitHub 原样拉**：`web/scripts/fetch-boardui.mjs components/base/select/select.tsx`
  会按 `@/` 与相对 import 递归补齐依赖（这次带进来 `dropdown/menu-styles.ts`、
  `foundations/icons/chevrons.tsx`、`utils/use-dismiss-on-outside-press.ts`）。
  已存在的文件默认不覆盖，`--force` 才重拉；文件头统一一行
  `// copied verbatim from BoardUI (MIT) — https://github.com/BoardUI/boardui/blob/main/<path>`。
  （文档站 `boardui.com` 的 RSC payload 里也有同一份源码，但 GitHub 更干净，别再扒页面。）
- 适配：`studio/fields.js` 的 `SelectField` 把调用点的原生 `<option>` 子节点拍平成
  `{value,label}`，适配层再渲染 `Select` + `SelectItem`；`selectedKey`/`onSelectionChange`
  与我们 `value`/`onChange(e.target.value)` 互译，空串仍走 `__empty__` 哨兵。
- **坑（这轮最大的一个）**：react-aria 的 Popover 默认 portal 到 `document.body`，落在
  `[data-dsh-studio]` 外面，作用域化的 Tailwind 全失效 —— 下拉会变成没有样式的裸列表。
  官方解法是 `react-aria/PortalProvider` 的 `UNSAFE_PortalProvider`：在 `web/src/bridge.jsx`
  用它包住整个面板，`getContainer` 指向 Radix 那个 `data-dsh-studio-portal` 容器，
  react-aria 的浮层和 Radix 的浮层从此共用一个容器、一套样式。为此把 `react-aria`
  提成直接依赖（版本与 react-aria-components 一致，3.53.1，不会打第二份）。
- 验证：`verify:fields` 20/20（新增 5 项：点开下拉、弹层在 portal 容器里、面板有壳子、
  选「缺陷」后按钮跟着变且卡片被筛成 0、清回「全部类型」卡片回来）。

### 体积：914.85 kB → 1058.88 kB（gzip 261.05 → 305.89）

涨的 144 kB 全在 react-aria 的 Select / ListBox / Popover / Overlays / Collections 这一串上，
不是我们的代码。原来定的 900 kB 红线在这条路上守不住 —— 要真组件就只能接受；
真要压回去，唯一办法是退回 Radix Select（等于不换骨）。取舍记在这里：
**保留真组件，体积红线改为 1.1 MB**，后续 tabs/drawer/modal 还会再涨，涨到离谱时再谈按页拆包。

### 第三批：Tabs（页面顶栏 + 卡片抽屉的页签）

- 用的是 `components/base/tabs/pill-tab.tsx` 的 `PillTabList` + `PillTab`（带滑动选中背景的胶囊页签，
  不是 `tabs.tsx` 那个下划线版本 —— 我们的场景是「切视图」而不是「切面板」，胶囊更贴）。
- 只改了一处实现：`components/studio-ui.jsx` 的 `TabsBar`，契约 `{items, value, onChange}` 一字未动，
  所以页面顶栏（8 个页签）和卡片抽屉（7 个页签）同时换掉。
- 顶栏原来是优先走 Radix 的 `Tabs/TabsList/TabsTrigger` 三件套，`TabsBar` 只在抽屉里用；
  这次把 `client.src.js` 的判断顺序改成**先 TabsBar**，Radix 那套降为兜底。
- `hint` 用原生 `title`：`PillTab` 不收 `title`，套 Radix Tooltip 又要求 forwardRef（会报 ref 警告）。
- 代价：DOM 里不再有 `role="tab"`，胶囊是 `button[aria-pressed]`。**所有探针**里
  `[data-dsh-studio] [role="tab"]` 都换成了 `.ds-head-tabs button`（抽屉里是
  `.ds-drawer [role="group"] button`），`capture.mjs` / `smoke.mjs` / `probe-unpriced.mjs` 也一起换了。
- 验证：`verify:fields` 20/20、`verify:facts` 5/5、`verify:costs` 7/7、`verify:scale` 9/9、
  `npm test` 108/108，七页逐个走一遍无 pageerror。体积 1058.88 → 1065.17 kB（胶囊几乎不要钱）。

### 六页回归固化成 `npm run verify:pages`

`tools/visual/pages-probe.mjs`：假宿主 + 真 Chrome，把七个页签逐个点一遍，每页三项断言
（点得动 / 渲染出了该有的标记 / 页签是高亮态），最后统一断言 `pageerror` 为空，
截图落到 `tmp/pages/<页签>.png`。共 22 项。

- 判据里专门查了 `innerText` 有没有「渲染失败」——React 的错误边界会吞异常，
  `pageerror` 是空的，只看它就等于没查（AGENTS.md §11 记过两次误判）。
- 页签选择器用 `.ds-head-tabs button`（胶囊是 `button[aria-pressed]`，没有 `role=tab`）。
- 每页的「该有的标记」：工作台 `.ds-body`；看板 `.ds-col`；需求/用例/版本/效能 `.ds-panel` 一族；设置 `.ds-panel`。
- 顺手确认：**仓库里没有 table/表格组件**（`grep ds-table` 空），所以 BoardUI 的 `base/table` 暂时没有调用点，
  清单里「table 接线」这一项其实无事可做，等真有表格页再说。

### 第四批：抽屉（Drawer）—— 自己实现，因为它是 Pro

- **BoardUI 的 Drawer / Modal 是 Pro**：公共仓库 `components/base/drawer|modal` 都 404，按既定约束
  「不买、不复制付费源码」，所以**没有源码可抄**。这一批是**我们自己写的等价物**：
  `web/src/boardui/drawer.tsx`，照公开文档的视觉与行为，用 react-aria 的
  `ModalOverlay + Modal + Dialog`（免费、和 Select/Input 同一套无障碍实现）拼出来。
- 行为交给 react-aria：Esc 关闭、焦点锁在抽屉内、关掉后焦点归还触发元素、portal 到
  `data-dsh-studio-portal` 容器（上一步的 `UNSAFE_PortalProvider` 直接复用）。
  原来手挂的 `window.addEventListener('keydown')` 整段删掉。
- 视觉用他们的 token：面板 `bg-background-primary-default`、左边 `border-separator-border`、
  标题 `text-title-3-semibold`、说明 `text-caption-1-medium text-text-secondary`、
  关闭按钮直接复用他们 MIT 的 `Button`（`iconOnly` + `leadingIcon={RiCloseLine}`）。
- 接线只改一处：`components/studio-ui.jsx` 的 `SheetDrawer`（`shell.js` 的 `SideDrawer`
  本来就把活交给它），所以设置页/集成页所有抽屉一起换掉。构建后的守卫从「6 个 Radix portal」
  降到 5 个 —— Radix Dialog 少了一个。
- 验证：新增 `npm run verify:drawer`（8 项）：能打开、开在 portal 容器里、面板用 BoardUI token、
  标题字号对、有关闭按钮、Esc 能关、无 pageerror。截图 `tmp/drawer-probe.png`。
- 已知小瑕疵：打开时焦点落在右上角关闭按钮上（react-aria 默认聚焦第一个可聚焦元素），
  所以截图里 X 带着一圈焦点环。可接受，但如果以后嫌吵，就把 autoFocus 指到第一个输入框。

### 清单口径（写清楚，别自己骗自己）

- **[5] tabs ✔ / table 无事可做 / drawer+modal → 归到 [8]**：仓库里没有表格组件
  （`grep ds-table` 为空），BoardUI 的 `base/table` 没有调用点；drawer/modal 是 Pro，
  自研等价物已落地（本轮）。

### 第五批：确认弹窗 + 状态标签

- **弹窗**（`DialogBox` → `web/src/boardui/dialog.tsx`）：同样是 Pro 组件，同样自己写。
  用 react-aria 的 `ModalOverlay + Modal + Dialog`，遮罩 `bg-black/55`、居中卡片
  `min(440px,92vw)`、标题用 `text-body-semibold`、按钮复用他们 MIT 的 `Button`
  （secondary + primary/danger）。确定性动作走 `danger` 变体（截图里「删除」是红的）。
  原来手写的 Radix Dialog 版整段删掉；构建后守卫从 5 个 Radix portal 降到 **4 个**。
- **状态标签**（`ChipField` → `base/badges/chip.tsx` + 适配层 `Chip`）：
  老代码用 `ds-chip-blocked` / `ds-chip-bug` / `ds-chip-code` 这类 **class 表达语义**，
  适配层把语义翻成他们的 `color`：阻塞/缺陷/危险 → `rose`，代码/缺服务 → `soft`，其余 → `gray`；
  变体统一用 `caption`（12/16/500），因为他们的 `bold` 是 14/20，会把密集列表的行高撑起来。
- `base/badges/badge.tsx` 也拉下来了，但它是「导航计数小球」，跟我们的状态标签不是一类，没硬套。
- 验证：`verify:drawer` 扩到 13 项（多了：点「删除」弹确认框、在 portal 里、用 BoardUI 背景、
  有取消 + 确认两个按钮、点取消能关掉），截图 `tmp/dialog-probe.png`；pages 22/22 仍全绿。

### 体积与 token 裁剪：算过了，不值当

- `theme.css` 定义行 575 行、**唯一 token 232 个**；用 postcss 跑一遍真实构建产物（`@tailwindcss/postcss`
  + 作用域插件），对每个 token 找 `var(--x)` 引用，再沿「token 引用 token」做一次可达性传播，
  结果是 **37 个 token 没人引用**（`--color-slate-200`、`--shadow-sm/md/lg/xl`、`--radius-2-5xl` 这类）。
- 37 个定义 ≈ 2–3 kB，而产物已经 1081 kB —— 裁了也回不到 900 kB，收益和「改错一个 token 就悄悄变色」的风险不成比例，
  所以**没有裁**。真想再瘦，只能退组件（退回 Radix Select 一类），那等于不换骨。
- 结论：**900 kB 这条红线取消，改成 1.1 MB 的观察线**；超过 1.1 MB 再来谈按页拆包。

### 第六批：统计卡 / 图表卡（[8] Pro 等价物，自研）

- **同样是 Pro，同样自己写**：`web/src/boardui/chart-card.tsx` 里三个小组件，
  照 BoardUI 图表卡公开文档的结构（标题 + 右侧附注 + 一句「所以呢」+ 主数字 + 图 + 脚注）拼的：
  - `StatCard`：KPI 方块（标签 / 主数字 / 解释），`warn` 时主数字走 `text-text-error-primary`
  - `ChartCard`：图表外壳（标题 + aside + hint + children + footer）
  - `BarRow`：卡片里的一行横条（名字 / 轨道 / 数值），比例 0–1，`tone` 控制配色
- 接线：效能页的 `kpi()` 改成渲染 `StatCard`（质量区 4 个 + 后面几块一起生效）；
  「周期分布」「每列停留（平均）」两块换成 `ChartCard + BarRow`。
- 没有引入任何图表库 —— 图仍然是 div 画出来的横条，体积只涨 3 kB。
- `verify:pages` 里「效能」页的判据从 `.ds-kpi` 改成 `[data-stat-card], [data-chart-card]`，
  这样组件没了会直接红，而不是被 `.ds-panel` 蒙混过去。
- **[8] 另外两项按现状搁置**，理由写在下面，不是「没做」而是「没有对象/风险不对等」：
  - 数据网格：仓库里没有表格组件（`grep ds-table` 为空），全是 `.ds-listrow` 行卡片；
    要做网格得先有一个真的表格场景，否则就是为组件而组件。
  - 任务列表：看板列本身就是「任务列表」，但它绑着拖拽、WIP 上限、分页（每列 40 张 + 显示更多）；
    抽壳会直接碰到 `verify:scale` 那条 1000 张卡的性能断言，收益不抵风险。

### 第七批：任务列表（[8] Pro 等价物的第三块）

- `web/src/boardui/task-list.tsx`：`TaskList`（复用 ChartCard 的外壳 + 空态）+ `TaskRow`
  （左标题 / 一行说明 / 右侧动作）。进效能页「返工最多的卡」，那一块原来是 `.ds-panel` +
  `.ds-listrow` + `.ds-btn` 三套 legacy 标记。
- 看板列**没有**动：那里绑着拖拽、WIP 上限和分页（每列 40 张 + 显示更多），
  抽壳会直接撞 `verify:scale` 的 1000 张卡断言，收益不抵风险。
- `verify:pages` 的页签判据加了第三段「必须存在」的选择器：效能页除了
  `[data-stat-card]/[data-chart-card]` 还要求 `[data-task-row]` 真的在，
  以免以后组件被换掉却因为别的选择器仍然匹配而蒙混过关。

### [8] 三块的最终口径

| 要的 | 结果 |
| --- | --- |
| 图表卡 | ✅ 自研 `StatCard` / `ChartCard` / `BarRow`，效能页已用 |
| 任务列表 | ✅ 自研 `TaskList` / `TaskRow`，效能页已用（看板列不动，理由见上） |
| 数据网格 | ⛔ **没有对象**：全仓库没有表格组件（`grep ds-table` 为空），也没有表格页面；
没有调用点就写一个没人用的网格，等于为组件而组件。真要做得先有表格场景。 |

### 体积观察线：1.1 MB（用户 2026-11-17 确认）

- 900 kB 那条作废 —— 真组件的成本摆在那里（react-aria 的 Select / ListBox / Popover / Modal
  一串占了 150 kB 上下），压回去只能退回 Radix，等于不换骨。
- 现在把口径写进**构建守卫**（`web/scripts/guard.mjs` 的 `--post`）：`dist/client.js` 超过
  **1126 kB**（1.1 MB）直接构建失败，并提示「查查又引了什么」。观察线要能拦人，光写在文档里没用。
- 当前 1085.68 kB / gzip 311.92 kB，离观察线还有 40 kB 余量。

## 真机验证（.218，2026-11-17）：逮到一个只有在真机才复现的 bug

部署：`DSH_DEPLOY_HOST=192.0.2.10 DSH_DEPLOY_USER=<user> node tools/deploy.mjs` → `active=active files=41`。
（脚本报的 `state=502` 是**假警报**：它 curl 的是 `127.0.0.1:18080`，而这台机器上 dsh 只绑在
`192.0.2.10:18080`，用局域网地址请求是 200、rev 16887。）

真机上跑出来的结果：
- `tools/visual/smoke.mjs`：`ok: true`（30 张卡 / 100 行用例 / 面板没崩 / pageerror 空）。
- 逐页：7 个页签全过，效能页的 `[data-stat-card]`、`[data-chart-card]` 在真数据下正常
  （一次通过率 60%、返工率 48% 标红、每列停留的横条有真实占比）。
- 抽屉与弹窗：**第一次跑挂了 3 项**。

### 抓到的 bug：抽屉打开后焦点留在 `<body>`，Esc 关不掉

- 现象：设置页抽屉能打开、也能点关闭，但**按 Esc 没反应**；`document.activeElement` 是 `BODY`。
- 原因：react-aria 的 Esc 处理要求事件发生在浮层内部，焦点在 body 上时它直接忽略。
  我们删掉了原来手挂的 `window.addEventListener('keydown')`，就没人兜底了。
- 为什么假宿主测不出来：那边没有宿主的全局焦点处理，焦点正好落在浮层里，Esc 一直好使。
  **`verify:drawer` 在这条上是假绿** —— 现在补了两条断言（打开后焦点在抽屉内 + 根节点带
  `data-boardui-overlay`），本地就能盯住。
- 修法（`web/src/boardui/overlay-escape.ts`）：
  1. `useFocusOnMount`：打开后如果焦点不在浮层里，把浮层容器（`tabIndex=-1`）聚焦；
  2. `useEscapeFallback`：在 `window` 上补 Esc 监听，**只关最上层那个浮层**
     （按 `data-boardui-overlay` 的出现顺序判断），免得关弹窗把底下的抽屉一起关了。
- 修完重新部署，真机复跑：抽屉 10/10、逐页 17/17、smoke `ok: true`。

## 整体样式与排版巡检（2026-11-17，真机 .218 + 2 倍高清局部截图）

巡检方式：`tmp/zoom-probe.mjs` 按元素 bounding box 裁 2x 高清图（头部/看板工具栏/看板列/设置面板/需求面板），
再配合七页整图看。结论：**大部分是「换骨」后的连带问题，不是新设计**。

### 修掉的

1. **页签八个长得一模一样**（最严重）：`<button>` 带了浏览器默认的 `border: 2px outset` + `#f0f0f0` 底色 ——
   BoardUI 的 PillTab 自己不写 border/bg（选中块由内层 span 画），被这层 UA 样式一盖，选中态完全看不见。
   我们刻意关掉 preflight，所以这类默认值必须自己清。做法：`[data-dsh-studio] .ds-pill` 精确清掉胶囊的 UA 样式。
2. **ghost 按钮带 3D 灰边**：BoardUI 的 ghost 变体不写 border 类，同样吃 UA 默认边框（真机上「打开 / 去看板」都带一圈灰边）。
   做法：一条**特异性为 0** 的 `:where()` 兜底，只清「没人指定」的部分，任何 class（`.ds-btn`、`.border`、`bg-*`）照常覆盖。
3. **顶栏「明亮 / 黑暗 / 跟随系统」与胶囊页签像两个年代**：原来是 Radix ToggleGroup 的灰底小方框，
   换成同一套 `PillTabList + PillTab`（`.ds-pill-sm` 收小一号），现在顶栏只有一种按钮语言。
4. **工作台 KPI 与效能页两套卡**：工作台还是 `.ds-kpi`（左侧一条彩色竖条），效能页已经是 StatCard。
   统一成 `StatCard`；任务行也从 `.ds-listrow` 换成 `TaskRow` + BoardUI 按钮。
5. **「流程与产出」那组数字和标签一个字号**，看着像没写完：加 `.ds-flow-num`（18/600）。

### 还没做（按优先级，留给下一轮）

- **设置页的分组框**：8 个「列与角色」分组之间没有分隔，纯靠留白，扫读时容易串行 —— 建议每组包成一张卡。
- **用例页的选择框**：仍是原生 `input[type=checkbox]` 的样子，和抽屉里的 BoardUI Checkbox 不一致。
- **用例页工具行**：`全选可跑的 59 条 / 清空选择 / ▶ 跑选中的` 还是 `.ds-btn` 灰按钮，和 BoardUI 按钮并存。
- **看板工具栏**：搜索框是灰底（BoardUI Input），下拉是白底（BoardUI Select），两者并排时底色不统一 —— 这是他们
  自己的设计语言（输入框灰、触发器白），要么统一给工具栏加底色，要么忍。
- **空态与表格**：`ds-empty` 的虚线框和老式斜体提示，是唯一还在用「换皮前」语言的元素。

### 第二轮巡检：把「分组」和「工具行」也收拾了

1. **「列的负责人」分组变卡片**：原来 `.ds-colrow` 只有一条 `border-bottom`，八个分组连成一片。
   改成描边 + 圆角 + 白底 + 一点阴影的小卡，组名 13.5/600。现在一眼能看出「这一组是待澄清、它挂产品」。
2. **用例页工具行换 BoardUI 按钮**：`全选可跑的 / 清空选择 / ▶ 跑选中的 / ↻ 只跑上次失败的` 从
   `.ds-btn`（灰底圆角）换成 `secondary / secondary / primary / secondary`，高度统一 32px，
   和旁边的 BoardUI 下拉、勾选框站在一起不再像两个系统。
3. **勾选框复核后无需改**：用例行里的勾选框本来就是 `CheckField`（BoardUI Checkbox），
   之前看着「像原生」是因为整行 `disabled`（未跑的用例不可选）导致 50% 透明。属于状态，不是样式问题。

真机复核截图：`tmp/zoom/列的负责人.png`、`tmp/zoom/用例工具栏.png`。
本地探针 pages 22/22、fields 20/20、drawer 15/15、scale 9/9，`npm test` 108/108。

### 关于「同一行里控件底色不统一」：定了，一个容器一种语言

BoardUI 自己的规矩是：**输入框灰底填充**、**下拉触发器白底描边**。单看都对，塞进同一行就露馅
（看板工具栏那个灰底搜索框像挖了个洞）。规则改成：

1. **工具栏 / 筛选行 → 全部白底描边**（跟下拉走）：`[data-dsh-studio] .ds-board-bar [data-field="input"] > div:first-child`
   改白底 + 1px 内描边（用 `outline` 不用 `border`，不改变 36px 高度）。
2. **表单（抽屉里）→ 全部灰底填充**（跟输入框走）：`.ds-drawer [data-field="select"] button` 去边框、改灰底。

为此在适配层给两个控件加了稳定钩子：`data-field="input"` / `data-field="select"`，
以后调样式不用靠 PI 工具类的类名。

### ⚠️ 顺手挖出来的隐患：Tailwind v4 把 theme 变量输出成自引用

排查上面这个问题时发现产物里有这种东西：

```
--color-background-primary-default: var(--color-background-primary-default);
--color-border-button-default:      var(--color-border-button-default);
```

即 `@theme` 的变量被输出成**指向自己**，解析结果为空 —— 于是 `.bg-background-primary-default`
算出来的 `background-color` 是 `transparent`、`.border` 的 `border-width` 是 0
（`border-style: var(--tw-border-style)` 在没有 preflight 时也会塌）。

目前只有下拉触发器踩到（已用 legacy 的 `--ds-*` 写死兜底，见上），但**凡是依赖这些
`--color-*` 的 BoardUI 样式都会静默失效**。这是下一轮该查的头号问题：确认是
`@config tailwind.config.js` 的兼容层还是 scope-css 的 `:root` 改写导致的，然后决定
「全部走 `@theme`」还是「全部走 theme.css 的 `:root`」，别再两套混着。

## 真机功能巡检（2026-11-17 下午）：揪出两处「整页 ReferenceError」

新增 `npm run verify:sweep`（真机 + token）：需求页逐条点开、卡片抽屉 7 个页签逐个切、
设置页 16 个分区逐个切。**页面级探针看不出分区炸没炸**，这一层必须单独跑。

跑出来两个真 bug（都属于 AGENTS.md §11 说的那类，`node --check` 查不到）：

1. **权限与审计**整页 `ReferenceError: ACCESS_ROLE_OPTIONS is not defined`
2. 修完立刻暴出第二个：**`ROUTE_LABEL is not defined`**（同一个病因，被前一个挡着）

病因：面板从 `client.src.js` 抽成模块时，常量留在了原文件里，模块那边**裸用没 import**。
而那两个常量在 `client.src.js` 里其实已经没人用了 —— 纯死代码 + 悬空引用。

修法：`STRATEGIES` / `ROUTE_LABEL` / `ACCESS_ROLE_OPTIONS` 三个表搬进 `web/src/studio/labels.js`
当唯一真源，`governance.js` 从那里 import，`client.src.js` 里的死定义删掉。
顺手写了个一次性扫描（`tmp/find-leaks.mjs`）把同类问题全找了一遍，剩下的都是
`client()` 解构出来的名字，不是真泄漏。

### 需求页布局错乱（用户报的那个）

真机复现：点开一条需求后，右侧详情被挤到列表下面，整页像上下堆了两块。
根因：宽屏用的是 flex + `flex-wrap: wrap`（为了顶部提示条独占一行），而详情
`flex: 1 1 auto` 的基准是**内容理想宽度** —— 它里面的矩阵/表格很宽，算下来超过剩余空间就换行。
修法：`flex: 1 1 0%` + `min-width: 0` + `overflow-x: auto`；选择器要写成 `div.ds-req-detail`，
因为原来那条 `> div:not(.ds-req-list)` 的类型选择器多一个，同权重下会赢。

### 灰字

`.ds-hint` 原来是 10.5px + **0.5 透明**（白底上基本看不清），改成 11.5px、不透明、用 muted-foreground；
`--color-text-secondary/tertiary` 各提一档（neutral-600/500）；面板头、列表头不再靠 opacity 压灰。

### 收尾：空态 / 按钮 / 列表行，以及「Tailwind 边框开关」那笔账

1. **空态 `.ds-empty`**：虚线框 → 实线浅框 + 圆角 + 浅灰底 + 居中（虚线框是上个时代的空态语言）。
2. **`.ds-btn`**：灰底小按钮 → 白底描边 32px，hover 变浅；`primary` 黑底、`ghost` 透明描边跟随。
3. **`.ds-listrow`**：表格行 → 无外框、悬停变色的行卡片，和 TaskRow 一致。
4. **BoardUI 按钮的外观改由 CSS 兜底**（关键）：实测 `bg-*` / `border-*` 这类**颜色工具类在宿主页里
   不生效**（布局类没问题，颜色类算出来永远 transparent / 0px）。所以在适配层给按钮加了
   `data-variant` / `data-size` 钩子，四个变体的底色/描边/高度全部写死。现在 secondary 是白底描边、
   primary 黑底、ghost 浅蓝、danger 红，禁用态统一 45% 透明。
5. **`--tw-border-style` 补齐**：Tailwind v4 的 `.border` 依赖这个变量（平时由 preflight 给），
   我们没引 preflight → `border-style` 是无效值 → 所有 `.border` 都没边框。在面板根上补
   `--tw-border-style: solid`，子元素继承。

> 这几条说明一件事：**把 Tailwind 当「类名 DSL」，但别指望它的颜色/边框工具类在宿主页里生效**。
> 颜色一律用 token 变量 + 自己的规则，类名只用来表达布局。

### 一个反复咬人的坑：legacy 样式是**后注入**的

`.ds-*` 的样式由插件在应用时注入 `<style>`，**晚于**我们 `main.jsx` 里那次注入。所以
同特异性的规则，legacy 一定赢 —— 今天「按钮/空态/列表行」的第一版就是这么静默失效的
（写的时候看着对，跑起来没变）。

规矩记下来：**覆盖 `.ds-*` 一律加权重**（`html body [data-dsh-studio] .ds-x`），或者干脆别覆盖、
直接换组件。今天已经在用的写法在 `index.css` 里能搜到 `html body [data-dsh-studio]`。

### 暗色主题：还差一口气（已知未完成）

暗色下大部分页面正常（需求页整页、看板列、抽屉都读过一遍），但**顶栏「＋ 新建」这类
`.ds-btn-primary` 在暗色下算出来是浅底 + 深字**（底色 `#fafafa`、文字 `#09090b`），
既不是我们写的深底白字，也不是 legacy 的 accent 底。
说明还有第三条规则在生效，本轮没揪出来 —— **可以读，但不好看**，记在这里当待办。

### 设置页 16 个分区：控件盘点（真机逐分区统计）

`tmp/settings-audit.mjs` 逐个分区数一遍控件，结果：

| 分区 | BoardUI 输入 | BoardUI 下拉 | BoardUI 按钮 | 老 input/select | 老 .ds-btn |
| --- | --- | --- | --- | --- | --- |
| 项目与迭代 | 0 | 0 | 7 | 0 | **0** |
| 专家 | 13 | 0 | 19 | 0 | **0** |
| 专家团 | 0 | 0 | 4 | 0 | **0** |
| 技能库 | 0 | 0 | 62 | 0 | **0** |
| 列的负责人 | 0 | 0 | 17 | 0 | **0** |
| 飞书机器人 | 3 | 0 | 3 | 0 | **0** |
| 集成健康 | 1 | 0 | 7 | 0 | **0** |
| 自动派单 | 4 | 3 | 1 | 0 | **0** |
| 测试执行 | 5 | 0 | 6 | 0 | **0** |
| 成本与预算 | 3 | 0 | 3 | 0 | **0** |
| 部署环境 | 6 | 3 | 5 | 0 | **0** |
| 统一登录（LDAP） | 11 | 0 | 3 | 0 | **0** |
| 权限与审计 | 2 | 3 | 4 | 0 | **0** |
| 数据与备份 | 0 | 0 | 11 | 0 | **0** |

「下拉」为 0 的分区不是没换，是**那些列表页本来就没有下拉**（表单里的下拉在抽屉里，早就是 BoardUI 了）。

**怎么做到一次全换的**：在 `main.jsx` 把交给 legacy 面板的 `h` 包了一层 —— 遇到
`h('button', { className: 'ds-btn …' })` 就渲染成 BoardUI 的 `Button` 组件：

- `ds-btn-primary` → `primary`，`ds-btn-ghost` → `ghost`，其余 → `secondary`（统一 small）
- 只拦 `button` 标签且带 `ds-btn` 类，`<label class="ds-btn">` 这类不变，其余元素原样透传
- 上百个调用点一个没改，组件却真换了

`verify:sweep` 的「设置 16 个分区逐个切换」仍是绿的，说明换组件没影响交互。

### 全站组件盘点（`npm run verify:audit`）

逐页面 + 两个抽屉数控件，结论：

| 位置 | B输入 | B下拉 | B按钮 | 老 input/select | 老 .ds-btn |
| --- | --- | --- | --- | --- | --- |
| 工作台 | 0 | 0 | 16 | **0** | **0** |
| 看板 | 1 | 4 | 4 | **0** | **0** |
| 需求 | 2 | 1 | 30 | **0** | **0** |
| 用例 | 1 | 2 | 112 | **0** | **0** |
| 版本 | 11 | 4 | 23 | **0** | **0** |
| 效能 | 0 | 2 | 13 | **0** | **0** |
| 设置 | 13 | 0 | 23 | **0** | **0** |
| 卡片抽屉 | 18 | 12 | 31 | **0** | **0** |

**控件层面已经 100% 是 BoardUI 组件**：输入框/文本域走 `[data-field="input"]`，下拉走
`[data-field="select"]`，按钮走 `button[data-variant]`，勾选框走他们的 Checkbox。

> 注意 `verify:audit` 里「原生 select」那一列看起来有值（看板 4、抽屉 12…），那是
> **react-aria Select 内部渲染的隐藏 `<select>`**（给原生表单提交用），和「B下拉」是 1:1 —— 不是残留。

**还剩下的两类（不是控件）**：
1. `.ds-listrow` 行布局（工作台 7 / 需求 4 / 版本 3 / 设置 8）：样式已经按行卡片重绘，
   但结构仍是我们的 `div + main + actions`。BoardUI 没有「列表行」组件，我们的 `TaskRow` 是等价物，
   换它要动这几个调用点的结构 —— 属于「等价物替换」，不是「控件没换」。
2. 登录门（`.ds-login`）里两个原生 `<input>`：独立于面板的登录页，token 登录不会走到，
   优先级最低，记在这里。

### 列表行也换成 TaskRow（同一个 h 层翻译）

`.ds-listrow` 的 DOM 形状非常固定：
`div.ds-listrow > (div.ds-listrow-main[标题, 说明], div.ds-listrow-actions[按钮…])`。
所以在 `main.jsx` 的 `h` 里再加一条翻译：**结构完全对得上**时渲染 `TaskRow`，否则原样透传
（避免把自定义行改坏）。

结果（`verify:audit`）：工作台/需求/版本/设置 的 `.ds-listrow` **全部降到 0**。
至此面板里剩下的「非 BoardUI」元素只有 `.ds-empty`（已重绘样式，BoardUI 无空态组件）
和登录页那两个原生 input（独立登录门）。

### 空态也换成了自研 EmptyState（第三条 h 翻译）

BoardUI 没有空态组件（它家是每个页面自带插画），所以照 drawer/dialog/chart-card 的老办法自研：
`web/src/boardui/empty-state.tsx` —— 浅底 + 描边 + 圆角 + 居中说明，可选图标与行动按钮。

`main.jsx` 的 `h` 里加第三条翻译：`div.ds-empty` → `EmptyState`。

**至此 `verify:audit` 的老控件列全为 0**（老 input / 老 .ds-btn / .ds-listrow / .ds-empty 全站 0）：

| 位置 | B输入 | B下拉 | B按钮 | 老控件 |
| --- | --- | --- | --- | --- |
| 工作台 | 0 | 0 | 16 | 0 |
| 看板 | 1 | 4 | 4 | 0 |
| 需求 | 2 | 1 | 30 | 0 |
| 用例 | 1 | 2 | 112 | 0 |
| 版本 | 11 | 4 | 23 | 0 |
| 效能 | 0 | 2 | 12 | 0 |
| 设置 | 13 | 0 | 23 | 0 |
| 卡片抽屉 | 18 | 12 | 31 | 0 |

> pages-probe 里 需求/版本/用例 的判据也同步改成 `[data-empty-state]` / `[data-task-row]`，
> 否则换了组件之后探针会因为找不到 `.ds-empty` 而误报。

**唯一还没换的**：登录门（`.ds-login`）里两个原生 `<input>` —— 独立页面，token 登录走不到。

### 看板卡片重绘（只动视觉，不动结构）

约束：**不碰 DOM 结构与拖拽**，所以 `verify:scale` 的「1000 张卡 / 每列 40 张 / 首屏 681ms」断言仍然有效。

- `.ds-col`：灰底 → 浅灰底 + 14px 圆角 + 柔和描边；
- `.ds-col-head`：白色底、12.5px/600、底部一条分隔线；
- `.ds-col-owner`：原来 `opacity:.55`（灰得看不清）→ 正常不透明 + muted-foreground；
- `.ds-card`：白卡 + 1px 柔和描边 + 圆角 11 + `shadow-xs`，hover 才抬 1px 并加深阴影；
- `.ds-card-title`：13px/600；
- `.ds-card-foot`：原来 `opacity:.5` → 不透明 muted-foreground。

`verify:scale` 9/9（含首屏出卡时间、每列 40 张、304 命中）、逐页 17/17、sweep 5/5 全绿。

### 暗色主题收尾：按钮改用 BoardUI 的渐变，两处硬编码颜色补上暗色版

追到根因了，而且**不是样式优先级问题，是我们自己写死颜色**：

1. **primary 按钮**：我原先写死 `#18181b`（黑）。BoardUI 的 primary 是**蓝色渐变**
   （`--gradient-button-primary-default` = accent-500→600）。黑底卡在暗色面板上几乎看不见 ——
   改用他们的渐变 token，浅色/暗色都对，而且这才是他们本来的设计。
2. **secondary 按钮**：原先写死白底 + 深字。改成
   `background/primary/default` + `text/primary` 两个 token，暗色自动变深底浅字。
3. **裸 `span.ds-chip`**（需求页「得分 54」这类）：`ChipField` 之外直接写的标签没走适配层，
   在 `h` 里加了第四条翻译（`span.ds-chip` → BoardUI `Chip`）。
4. **「只看阻塞 / 只看缺正文」**：暗色下深红 `#c0392b` 糊在深底上，补一条暗色专用浅红。

暗色巡检（`tmp/dark-check.mjs`，逐页找「深底上的深字」）现在 **五页全部 0 可疑元素**。

### 登录门（`ShadcnLoginGate`）换 BoardUI + 揪出一个真 bug

查的时候发现两件事：

1. **用户在真机上看到的登录卡不是 legacy 的 `.ds-login`**，而是 `components/login-gate.jsx` 的
   `ShadcnLoginGate`（main.jsx 通过 `pageProps.loginGate` 注入的）。我先前改的 legacy 版是**兜底路径**，
   真机上根本走不到 —— 已把真正那份的两个 `<Input>` 换成 BoardUI 适配层的 `Input`
   （它不收 ref，所以切 tab 时的聚焦改成按 id 聚焦）。
2. **`components/ui.jsx` 里 `BoarduiButton` 只用了没 import** —— 只要走「非 asChild 的 Button」分支
   就 `ReferenceError: BoarduiButton is not defined`（登录卡的「登录」按钮正好走这条，于是整张卡崩）。
   这是当初接 Button 时漏的，一直被别处用 h 翻译的按钮挡着没暴露。补上 import。

新增 `npm run verify:login`（假宿主 + locked 状态）：登录卡出现、两个输入框是 BoardUI 壳子、
密码框仍是 password、有标签、点得到「登录」、登录后进面板 —— 7/7。

### 选项卡：从「胶囊」改成真正的 tab（这处我之前用错了组件）

截图里那两条（顶栏 工作台/看板/…、抽屉 概览/内容/…）**本来就是选项卡**，我先前用的是
`PillTabList + PillTab` —— 那是 BoardUI 给「视图切换」用的胶囊：没有 `role="tab"`、
没有 `aria-selected`、没有方向键导航。语义上放错了位置。

试过直接用他们的 `components/base/tabs/tabs.tsx`（Tabs + TabList + Tab，带下划线指示器），
**在宿主页里一挂载就抛 `TypeError: Cannot read properties of undefined (reading 'title')`**：
精简 props（只留 id/children）、包一层 `I18nProvider` 都试过，仍然崩。
（排查时还误以为是自己的 fixture 缺字段，实际是 fake host 的 config 不含 board —— 两个坑叠在一起。）

所以按他们那份的**视觉与语义**自己实现了一个（`web/src/components/tabs-bar.jsx`）：
- `role="tablist"` / `role="tab"` / `aria-selected` / roving tabindex
- ← → Home End 键盘导航
- 底部下划线指示器（跟随选中项，带 200ms 过渡）
- `count` 角标（抽屉「测试 0/3」这类）
- 类名用 `studio-tab*` 而不是 `.ds-tab*`：legacy 的 `.ds-tab` 规则后注入，会把 padding
  和选中底色一起盖掉（第一次改完页签挤成了一坨，就是这个原因）

`verify:pages` 22/22、真机 sweep 5/5、audit 老控件 0、`npm test` 108/108。

### 下拉框专项盘点（`npm run verify:selects`）

用户反馈「下拉选择框没用组件」，于是写了个专项探针：逐页面 + 抽屉，找**真实可见的原生 `<select>`**
（react-aria 的 Select 内部也有一个隐藏 select，必须排除掉，否则会误判）。

结果：工作台/看板/需求/用例/版本/效能/设置/卡片抽屉/设置抽屉/业务提单 —— **可见原生 select 全部 0 个**。
展开后的面板也验了：白底 + 1px 描边 + 圆角 + 阴影，选中项带对勾，挂在 `data-dsh-studio-portal` 里。

同时补了**第五条 h 翻译**：`h('select', {...}, option…)` → BoardUI `Select`
（legacy 里还剩业务提单表单这两处原生 select），以后再有裸 select 也会自动变成组件。

### 官方安装方式（照 docs 走）

文档写的是：`npx boardui init` 初始化（写 components.json、装依赖、接样式表），
之后 `npx boardui add <component>` 逐个加；也可以**手动**复制源码。npm 包是 `boardui@0.5.9`。

我们这个插件用的是「手动」那条路（`web/scripts/fetch-boardui.mjs` 从 GitHub 原样拉、保留 MIT 头），
因为我们的 Tailwind 是**作用域化注入宿主页面**的，套不了他们的 init 模板；文件产物与 `add` 一致。

### 第一项：分段控件（官方 SegmentedControl）

主题切换「明亮/黑暗/跟随系统」原来是胶囊（PillTab）—— 那是视图切换的语义，用错了。
现在换成官方 `components/base/segmented-control/segmented-control.tsx`：
`SegmentedControl + SegmentedControlItem`，`selectedKeys` 单选取值，带滑动的高亮块。
容器与滑块的底色用 token 写死（`.ds-seg-control`），因为 Tailwind 的 bg-* 工具类在宿主页里不生效。

真机截图：`tmp/zoom/头部与页签.png`（右侧三件套现在是标准分段控件）。

### 第二项：开关改用官方 Switch

「启用/停用」这类**即时生效的布尔状态**原来用 Checkbox 渲染，语义不对（勾选框是"选中某一项"）。
现在改成官方 `components/base/switch/switch.tsx`：

- `fields.js` 新增 `SwitchToggle`（与 `CheckField` 同样的 checked/onChange(e) 入参，内部渲染官方 Switch）
- 通过 `provideClient` 注入，面板里 `h(CheckField → h(SwitchToggle` 的有 9 处：
  权限与审计 2、集成与仓库 4、专家 2、项目与迭代 1
- **勾选框语义的地方保持 Checkbox**：看板筛选（隐藏空列/只看阻塞）、自动派单的列多选、用例勾选

坑：`provideClient` 与 `createFields` 两处解构都要加 `SwitchToggle`，少一处就是
`SwitchToggle is not defined`（第一版就漏了 createFields 那行，设置页整片崩）。

体积：接官方 SegmentedControl + Switch 后 1128 kB，观察线从 1.1 MB 抬到 1.2 MB（守卫同步）。

### Progress / Pagination：查过之后**不该硬换**

- **进度条**：`components/base/` 里**没有 progress**（github 目录清单实证：announcement/avatar/badges/
  breadcrumb/buttons/carousel/checkbox/date-picker/divider/dropdown/file-upload/input-otp/input/kbd/
  notification/pagination/radio/segmented-control/select/slider/social-button/switch/table/tabs/
  textarea/tooltip/tree-view）。所以进度条只能自研 —— 这不是"没换"，是**没有可换的免费源码**。
- **分页**：官方 `Pagination` 是**页码分页器**（page / totalPages / onChange），
  而看板列用的是「显示更多」的**增量加载**（每列 40 张，`verify:scale` 就是按这个断言的）。
  换成页码器会改交互、并让性能断言失效 —— 不是组件用错，是模式不同。

真正还该换、并且公共仓库里确实有的：`tooltip` / `date-picker` / `table` / `dropdown` /
`notification` / `kbd` / `avatar` / `divider` / `file-upload` / `tree-view`。

### 第三项：提示框改用官方 Tooltip

`Tip({label, children})` 原来挂 Radix Tooltip，现在换成官方
`components/base/tooltip/tooltip.tsx`：`TooltipTrigger`（delay 260ms）+ `Tooltip`。
子元素是单个可交互节点时 react-aria 会克隆它挂事件；`label` 为空直接返回 children（保持原行为）。

Radix 的 portal 计数从 4 降到 **3**（少了一个 Tooltip 门户）。
真机 sweep 5/5、页面 22/22、pageerror 空。

### 下一棒：DatePicker（源码已就位，尚未接线）

`components/base/date-picker/{date-picker,shared}.tsx` 已经原样拉进仓库（含
`foundations/template-copy`），API 是：

```tsx
<DatePicker value={CalendarDate|null} onChange={(d) => ...} />
```

**卡点**：它用的是 `@internationalized/date` 的 `CalendarDate`，而我们所有调用点传的都是
`'YYYY-MM-DD'` 字符串（`toDateInput/fromDateInput` 已经在用这套）。接线需要一层转换
（`parseDate` / `CalendarDate.toString()`），并且会引入 react-aria 的 Calendar/DateField，
体积预计再涨 60–100 kB（当前 1153 kB，观察线 1.2 MB —— 需要同时决定是抬线还是按需加载）。

调用点共 5 处：`client.src.js` 1、`drawer.js` 1、`releases.js` 1、`platform.js` 2。

### DatePicker：实际接线时撞到的第二个依赖（结论：暂时不接）

按计划接线时，构建直接报：

```
[vite]: Rollup failed to resolve import "motion/react"
from ".../components/base/date-picker/date-picker.tsx"
```

也就是说官方 DatePicker 除了 `@internationalized/date`（已装）**还依赖 `motion`（framer-motion）**。
两个依赖 + react-aria 的 Calendar/DateField 一起进包，体积会明显越过现在 1.2 MB 的观察线。

所以这一步的结论是：**接 DatePicker 不是「换个组件」，而是引入一条新依赖链**。
真要接，先决定三件事：
1. 是否接受 `motion` 这个动画库进包（约 +50 kB，且是运行时动画依赖）
2. 观察线放宽到 1.3–1.4 MB，还是对它做**按需加载**（日期选择器只在抽屉里用，可以懒加载）
3. 5 个调用点的字符串 ↔ CalendarDate 转换（适配层代码已经想好，见 `tmp/patch-date.mjs` 的草稿）

代码已回滚到绿色状态（1156 kB / 3 个 Radix portal / pages 22/22），依赖保留。

### DatePicker 接线完成（含 motion 依赖）

- 装 `motion`（date-picker 用它做弹层动画），加上之前的 `@internationalized/date`
- 新增 `DateField` 适配层：`'YYYY-MM-DD'` ↔ `CalendarDate` 互转
- 5 处调用点全部换成官方 DatePicker：client.src.js / drawer.js / releases.js / platform.js×2
- **体积 1156 → 1416 kB**（motion + react-aria Calendar/DateField + date 库），
  观察线相应抬到 1.4 MB（守卫已同步）
- 验证：fields 19/19（含日期控件那条）、pages 22/22、真机 sweep 5/5

### 第四项：轻提示（toast）改用官方 Notification

`ToastHost` 原来渲染自己写的 `.ds-toast` dv，现在渲染官方 `components/base/notification/notification.tsx`：

- 面板侧通过 `kit('Notification')` 取（宿主没给就退回旧的极简样式，保证单文件产物不崩）
- 映射：`title = 文案`、`status = success|error|info|warning`、`dismissible` + `onDismiss`
- 原来那套 `.ds-toast` 的图标/关闭按钮/重复文案 600ms 去重逻辑都保留（去重在 `toast()` 里，与渲染无关）

顺带把 `avatar` / `close-button`（notification 的依赖）也拉进仓库。
体积 1391 kB，观察线 1.4 MB 内。
验证：pages 22/22、drawer 15/15、真机 sweep 5/5。

### 下拉「明明用了官方组件却不像官方」——两个真因（2026-11-17）

用户连着两次指出「看板里的选择框没用 BoardUI 的 Select」。排查下来**组件确实是官方的**
（`[data-field=select]` → react-aria `Select` + `SelectItem`），但看起来完全不像，
原因在样式链，不在调用点：

**真因一：`@layer base` 排在了 `utilities` 后面。**
CSS 层叠层按「名字第一次出现的位置」定优先级，后出现的压前面的，与特异性无关。
我们没引 preflight，所以 `base` 这个层名直到 index.css 自己写 `@layer base{}` 才第一次出现，
被追加到最末 —— 成了最强的一层。于是 base 里那条清 UA 默认值的
`:where(button){padding:0;font:inherit;border:0}` 反过来压住了所有工具类：

| | 修前 | 修后（官方值） |
| --- | --- | --- |
| 触发器内边距 | `0px` | `8px 10px` |
| 触发器高度 | 21px | 38px |
| 字号 | 12px（继承） | 14px（body-medium） |

修法：index.css **第一行**声明层序 `@layer properties, theme, base, components, utilities;`
（Tailwind 只在启用预检时才输出这行，关了就没了）。守卫已加两条断言，防止有人把它挪走。

**真因二：门户容器是 `position: fixed` 却没给 z-index。**
`fixed` 自身就新建层叠上下文（z-index:auto → 0），弹层里那句 `z-index:100000` 只在门户内部
有效，整层门户仍排在页面内容之下 —— 看板列头的 `.ds-col-head{position:sticky;z-index:2}`
直接盖在展开的菜单上，菜单像透明的。修法：给 `[data-dsh-studio-portal]` 加 `z-index: 900`。
守卫同样加了断言。

**顺手清掉的第二套实现**（体积 1353.80 → 1298.53 kB，−55 kB）：

- `studio-ui.jsx` 的 `SelectBox`（Radix Select）—— 0 个调用点，删
- `studio-ui.jsx` 的 `SwitchBox` + `ui.jsx` 的 `Switch`（Radix Switch）—— 同上，删
- `main.jsx` 的 uiKit 不再暴露 `Tabs/TabsList/TabsTrigger/SelectBox/SwitchBox`
- `client.src.js` 顶栏页签的 Radix Tabs 退路（TabsBar 一定存在，那条分支永远走不到）

守卫新增：`@radix-ui/react-select` / `@radix-ui/react-switch` 禁止 import（全站只允许一套实现）。

**验收方式换了**：`verify:selects` 不再只数「有没有原生 select」，而是逐个页签断言
触发器尺寸 = 官方 md（内边距/高度/字号），并把弹层真的点开，断言白底/16px 圆角/8px 内边距/
宽 266px/**elementFromPoint 落在弹层里**（防的正是上面那个层级 bug）/菜单项行高 ≥30px。
`verify:audit` 从 7 个页面扩到 **29 个模块**（8 页签 + 18 设置面板 + 3 抽屉），
作用域补上 `[data-dsh-studio-portal]`，违规非零直接退出码 1。

### 更正：BoardUI **有**进度条（meter + progress），我之前判断错了（2026-11-18）

我上一轮说「BoardUI 的 components/base 里没有进度条，所以自研 ProgressBar 是合理的」。
**这是错的**，依据也不成立 —— 我只查了公开仓库 `BoardUI/boardui` 的 `components/base`
目录，而官方站点上「计量条」和「进度」两个组件都在（标着「全新」）。

真因：**新组件只在官方 registry 里**（`https://www.boardui.com/r/<name>.json`，
`npx boardui add <name>` 用的就是它），公开仓库 main 是个旧快照。仓库 tree 里
227 个文件全搜一遍都没有 meter/progress，registry 里两个都在（meter.json 4.9 KB）。

于是把 `fetch-boardui.mjs` 改成 **registry 优先、GitHub 兜底**，拉下来三个文件：

- `components/base/progress/progress.tsx`（ProgressBar / ProgressTrack / ProgressCircle）
- `components/base/meter/meter.tsx`（Meter：带 `tone`，画在 ProgressBar 同一条轨道上）
- `components/base/spinner/spinner.tsx`（progress 的依赖）

接线：看板/效能里那些「本列占 X%」是**量**而不是「任务推进」，而且要按 over/warn 变色，
所以 `ProgressBar` 适配层渲染官方 **Meter**（`tone: accent|success|warning|error`），
另外导出官方 `Progress` 给真正需要 `role=progressbar` 的场合。Radix Progress 彻底移除
（守卫已禁 `@radix-ui/react-progress`，portal 数 3 → 2，体积 1298.55 → 1308.47 kB）。

顺带清掉同一页里的第二条实现：效能页的「团队负载」原来是手画的 `.ds-an-track/.ds-an-fill`，
和隔壁走 `kit('ProgressBar')` 的「预算使用」并存 —— 现在都走 `ProgressField`。

**这轮抓到的第二个探针缺陷**：`verify:audit` 每屏只等 850ms，「效能」页要等接口回来才画图，
于是 9 个官方计量条一个都没被统计到，`meter == 0` 的断言反而「通过」了。
等待改成 1800ms，并加了「全站必须至少有一个 role=meter」的断言 —— 现在是 9 个。

### 本地补丁清单（改过 BoardUI 源码的地方）

原则仍是「原样复制」，但有两处**必须**改，否则组件在宿主里不可用。每次 `--force` 重拉后要复核。

| 文件 | 补丁 | 为什么 |
| --- | --- | --- |
| `components/base/notification/notification.tsx` | `NotificationViewport` 增加 `container` 参数，`createPortal(node, containerProp ?? document.body)` | 官方写死 `document.body`，浮层落到 `[data-dsh-studio]` 外，作用域 CSS 全失效 |
| `components/base/toast/toast.tsx` | `ToasterProps` 增加 `container`，透传给 `NotificationViewport` | 同上；面板要把 toast 挂进 `[data-dsh-studio-portal]` |

补丁都带 `本地补丁：` 注释。守护脚本暂未断言这两处，重拉时要人工核（`grep -n "containerProp ?? document.body"`）。

### 组件盘点结论：还剩下哪些「自研」，以及为什么不换（2026-11-18）

用 `review:components`（运行时按类名统计官方 vs 自研）扫了 24 个模块，官方元素 2156 / 自研 2812。
但自研里绝大多数是**布局容器**（`ds-panel` / `ds-row` / `ds-field` / `ds-hint` / `ds-label`），
真正属于「组件」且仍自研的只有下面几个，每个都有明确结论：

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 审计日志表 | **已换** 官方 Table + Pagination | 原来 120 行 × 5 列平铺（600+ 节点），现在每页 50 行 |
| 命令面板输入框 | **已换** 官方 Input | 全站最后一个原生 `<input>`；注意官方 Input 是「壳 + 内部 input」两层，样式要跟着改，否则内部 input 会缩成 4px |
| 状态圆点 `ds-dot` | **不换** | 官方 `status-dot` 只有 green/yellow/indigo，**没有红色**；而它表达的是优先级（urgent 红），换过去等于丢掉「紧急」信号 |
| 指标卡 `ds-stat` | **不换** | 官方 `stat-cards` 的 `Stat` 强制 `delta` + `deltaColor` + `icon`，我们没有趋势数据，只能编造；`warn`（超阈值变红）也无处安放 |
| 设置左栏 `ds-nav-item` | **不换** | `r/sidebar.json` 是 `registry:block` 的 **DashboardSidebar**：团队切换器 + 用户菜单 + 主题切换 + KBD + settings-modal，三个文件约 40 kB、12 个 regdeps。它是「应用级侧栏」，不是「一组导航项」；接进来会重复已有功能并把包再撑大 40 kB |
| 看板卡片 `ds-card*` / 任务行 / 空态 | **不换** | 官方 `task-list`、图表类（`bar-list-card`/`area-chart-card`/`activity-rings-card`）在 registry 里都是 **404**（Pro），`empty-state` 也不存在 |

结论：**表单控件已 100% 官方**（Input / Textarea / Select / SearchField / Checkbox / Switch /
DatePicker / 命令面板输入框），数据展示层用官方 Table，浮层用官方 Drawer / Modal / Tooltip /
Toaster。剩下自研的都是「官方没有、或者语义不兼容」的部分。

## 设计基线（2026-11-18 会诊后定）

- **字号 5~7 档/页，最小 11px**：半档（9.5/10.5/11.5/12.5/13.5）已全部收敛；层级靠字重+颜色+间距表达，
  不再靠"再加 0.5px"。
- **三档圆角**：控件 10px、容器 16px、胶囊 999px。同屏出现两种卡片圆角是明显的"两套语言"信号。
- **间距**：仍是历史遗留（81 种 padding），收敛需要逐屏截图对比，留待后续。
- **主色走 token**：`--gradient-button-primary-default`，不要再写死色值。
- **legacy 变量别名**：`--ds-line / --ds-surface / --ds-bg` 已在浅色主题补齐（80 处内联样式依赖它们）。

## 下一轮待办（批次 2 剩余，2026-11-18 会诊后排定）

三项都来自三位设计专家（UI 设计师 / UX 架构师 / UX 研究员）的会诊，按「感知大、风险低」排序。
**每项都要求先出截图确认方向，再一次性铺开** —— 首屏类改动不先看效果，很容易改出一版没人认的。

### 1. 工作台首屏（感知最大，只动一屏）

现状：8 张 `StatCard` + 8 格流程 = **16 个同级数字**（20px 与 18px，差 2px 读不出层级），
6 个风险清单全在折叠线以下。页面自己的文案说「今天该看什么」，视觉上却没回答。

改法（只动 `web/src/studio/pages/insights.js`，复用现有 `StatCard` / `ds-panel`）：

| 层级 | 内容 | 视觉 |
| --- | --- | --- |
| 一级 | 逾期 / 阻塞 / 缺陷超时 / 准出被拦（2×2） | 数字 24px，标题「今天要处理」 |
| 二级 | 在办卡 / 流水线失败 / 集成异常 | 16px，标题「整体情况」 |
| 三级 | 6 个清单合成 1 个带内部分段的「风险清单」 | 面板内标题 12px 次级 |

### 2. 顶栏减负（与首屏同主题，建议同批验收）

**状态：未做，等确认。** 这一项会动使用习惯（刷新/导出卡/导出需求要收进菜单），
而且必须验证菜单的展开/收起/键盘，属于「先看效果再定」的一类。

顶栏减负的现成改法（下一轮照着做，约 30 行）：

现状：`👤超管 chip ｜ 登录 ｜ 明亮/黑暗/跟随系统 ｜ 刷新 ｜ 导出卡 ｜ 导出需求 ｜ ⚠集成异常 ｜ ＋新建`
—— 8 个同级 ghost 按钮里那个 primary 会被当成第 9 个。

改法：主题三选收进设置（低频配置）；刷新 + 导出卡 + 导出需求合并成「⋯」菜单；
登录与超管 chip 二选一（已登录时 chip 点开就是退出）；集成异常降级为图标点。
顶栏只留：**品牌 ｜ 状态 chip ｜ ⋯ ｜ ＋新建**。

### 3. 间距收敛（81 种 padding → 6 档 2/4/8/12/16/24）

**放最后做，且必须逐屏截图对比。** `padding` 与字号/圆角不同：改它一定会移动元素。
很多值是"调出来的"（`9px 11px`、`11px 12px`、`14px 15px`），机械归位会让看板卡片、
设置面板这类已经紧凑的地方出现挤压或松弛。

### 已知不需要再论证的结论

- 状态圆点 / 指标卡 / 设置左栏 / 看板卡片 / 空态 / 图表卡：官方无对应物或语义不兼容，保持自研（见上文对照表）
- 二级文字对比度、`--ds-line` 浅色未定义、主按钮色 token：**已在 0.2.4~0.2.6 修完**

### 用例库：草稿与「无断言」必须分得开（0.3.7）

用例库的类型列原来是「接口 / shell / 数据库 / 手工」四选一，于是**生成器留下的空壳**
（只有标题、没有可执行断言）被显示成「手工」，看起来像是有人故意做的人工用例——
全库 111 条里有 41 条是这种。改法：

- 类型列如实说：没有 `http`/`shell`/`db` 的显示 **草稿**（`draft` 标记为真）或 **无断言**（旧数据没有标记），
  用 `ds-hint` 的弱化样式，加 `title` 说明「跑不了，也不计入可执行覆盖率」
- 筛选加一档：`全部用例 / 只可跑 / 只看无断言 N`，N 跟着其它筛选实时变
- 工具栏提示补一句「另有 N 条没有可执行断言」，避免有人以为「全选可跑」漏了东西

数据侧同时修了一处：`sanitizeCase` 以前不保留 `draft`，这个标记存取一圈就没了，
所以草稿和人工用例在数据上分不开（`src/host/domain.js`）。
探针：`npm run verify:cases`（真机 + 真 Chrome，8 项，已接进 `release:preflight`）。

## 2026-11-20 · 体积观察线从 1460 抬到 1470 kB

五块能力 UI（项目检查 / 合并门禁 / 技能沉淀 / 浏览器用例 / 设计多稿）合计 +9 kB，
1451 → 1461.7 kB（gzip 420.7）。涨的是能力不是组件库，所以按实际抬线，并记一笔：
**这是最后一档**——单文件 IIFE 超过 ~1.5 MB 宿主首屏会明显变慢，下一个功能要么拆包要么先删。

## 2026-11-20 · 工作台「卡片压在面板上」是怎么量出来的（0.9.53）

用户截图里工作台的毛病看着像"重叠"，但 DOM 里没有任何两个可见元素真正相交 —— 因为**盒子没交叠，
是 0 距离紧贴**：`.ds-kpi-section` 只有区内 `gap: 8px`、自己没有下边距；`.ds-panel` 只有
`margin-bottom: 14px`。于是「整体情况」这一节的底边 = 下面「流程与产出」面板的上边线，
落单的「AI 在跑」卡片正好骑在那条线上，卡片的圆角+投影和面板的圆角+描边并到一起。

量法（可复现）：拿真机 `/studio-api` 的数据在假宿主里渲染真 `client.js`，逐块取
`getBoundingClientRect().top - prev.bottom`，真机 2414px 宽给的数字是：

| 相邻块 | 修复前 | 修复后 |
| --- | --- | --- |
| KPI 区块 → KPI 区块 | 6px | 14px |
| KPI 区块 → 面板 | **0px** | 14px |
| 效能页 小节标题 → 栅格 | **-2px** | 8px |
| KPI 网格（各 5 张） | 4+1（落单） | 5（一行） |

判据进了 `npm run probe:panel` 的 ⑥ 两项：正文直接子块间距 ≥ 8px、KPI 末行不许只剩一张。
**只验"有没有元素相交"是抓不到这类问题的**（相交数一直是 0），必须量相邻块的间距。

## 界面审视（unslop 口径，2026-11-22）

用 [heydamir/unslop](https://github.com/heydamir/unslop) 的方法（审计 → 定方向 → 九道 pass）把全部功能面看了一遍：
**32 个面**（7 页签 + 设置 18 分区 + 抽屉 5 页签 + 命令面板 + 新建抽屉），浅色全量 + 深色抽 6 面。

```bash
node tools/visual/ui-audit.mjs --base http://127.0.0.1:<dsh 端口>          # = npm run audit:ui
node tools/visual/ui-audit.mjs --base ... --theme dark --only board,drawer
```

它和既有探针的分工：`verify:audit` 查「还有没有原生控件」，`verify:a11y` 查「可访问名称与对比度」，
`review:layout` 查「字号/溢出/硬编码颜色」，**`audit:ui` 查"设计系统本身是否一致"**——
4px 网格、字号档位、颜色 token 数量、emoji 是否当图标、圆角层级、首屏空白、网格落单、文字截断。
它只出证据（截图 + `tmp/unslop-audit/metrics*.json`），不改代码，也不进发版闸门。

四条结论（完整报告见 [`ui-audit-2026-11-22.md`](ui-audit-2026-11-22.md)；一天后的复审与修复见 [`ui-audit-2026-11-24.md`](ui-audit-2026-11-24.md)）：

1. **字体从未落地**：`boardui/theme.css` 引用 `--font-inter`，但仓库没有 `@font-face`、没有字体资源，
   实测全部文本回落到 `ui-sans-serif`。要么自托管 Inter，要么把 token 改成系统字。
2. **两套设计系统并存**：BoardUI 是 4/8/12/16 + 圆角 8/16，手写 `.ds-*` 是 6/10/14/18 + 圆角 10，
   于是实测圆角 7 种、非 4px 网格最常见的是 `gap:6px`（1044 次）。
3. **emoji 就是图标系统**：18 个图形符号，32 面全中（抽屉出现 28 次/面）。专家 emoji 是数据字段
   （`config.experts[].emoji`），在 8 处渲染，不能靠全局替换，要按 role 映射线性图标。
4. **干净的部分别动**：渐变文字 0、彩色发光 0（96 处阴影全是同一枚中性软阴影）、循环动效 0、
   暗色 6 面 0 处对比度失败。

### 看板列宽（2026-11-22）

8 列原来固定 288px，1440 的屏一屏只放得下 5 列。现在默认 `flex: 1 1 200px`
（200–360 自适应，列多先横向滚），看板筛选条上多了一个「适应宽度」开关，
勾上后把列压到一屏放下（1440 下 8 列 × 166px），状态记在 `localStorage.studio.boardFit`。
不用 `--` 前缀的 CSS 变量：勾选状态走 `data-fit` 属性，样式里只认这个属性。

### 代码改动用 BoardUI 树形视图（2026-11-24）

抽屉「执行记录 → 代码改动」的文件清单换成 **BoardUI TreeView**（`components/base/tree-view/tree-view.tsx`，
源码原样 vendored，只去掉上游的 motion 展开动画——原因写在文件头注里）：目录分组、树线、React Aria 的
展开/选中/键盘导航都来自上游。每个文件行右侧带「新增 / 修改 / 删除 + +N −M」；选中文件在树下方渲染它的
统一 diff（增/删/hunk 分色），也可以切「全文」读工作树里的文件本体（带行号，只读路由 `/task/file`，越界与 200KB 上限都拒/截断）。git 只给扁平路径，目录树在 `drawer.js` 里拼（`buildDiffTree`）。

DOM 钩子：`[data-diff-tree]`、`[data-diff-file]`、`[data-change]`、`[data-diff-content]`；
panel-probe ⑦ 用真卡断言「树里的行数 > 文件数（说明目录分组生效）」「点第二个文件内容区跟着换」
「patch 行数 > 5」。树高上限 280px、独立滚动，避免大改动把抽屉撑爆。

## 构建体积观察线（2026-11-27 调整）

单文件 IIFE `dist/client.js` 的观察线从 1470 kB 抬到 **1490 kB**（实测 1472 kB）。
这一轮增加的是**设置项入口与交互闭环**（多维表格镜像 / 缺陷 SLA 与默认验收清单 / 自动重试三件套 /
shell 默认目录 / 密钥清除 / 乐观锁提示），没有引入新的组件库或第三方依赖。

**这一档是硬顶**：超过 1490 kB 就不再抬线，改为分片加载或把 BoardUI 换回宿主注入 —— 
单文件产物到 1.5 MB 时宿主首屏会明显变慢。
