# dsh-studio 与 DeepSeek Harness 的兼容性

本文是**单一事实源**：列出 dsh-studio 依赖的每一个宿主接口、它失效时用户看到什么、以及升级 dsh 之后必须按顺序验证什么。改动任何宿主调用（`ctx.*`、`__ModuleLoader__`、CLI 用法）时，必须同步更新本文件。

## 1. 已验证版本

| 项 | 值 |
| --- | --- |
| dsh-studio | `package.json` `version: 0.18.3` |
| DeepSeek Harness | `0.2.2-rc.1`（`dsh --version`） |
| Node | `v24.22.2`（Linux 目标机）；本机 Windows `v24.19.0` |
| 目标系统 | Ubuntu 24.04，`dsh web` 监听 `18080`，nginx `:80` 反代并注入 `dsh-auth-*` cookie |
| 插件安装方式 | npm：`dsh plugin --profile web add @marsken/dsh-studio`；本地开发：`add link:~/dsh-studio`（profile `web`） |
| 验证范围 | 0.18.2：只含「会随 npm 包发出去的内网地址/个人路径」清理（面板占位符 `kb.example.com`、docs 与源码注释改用 `192.0.2.10` / `<user>`）。`npm run check` 693 通过、`release:check` 7 项通过、产物 `cmp` 一致；其余验证沿用 0.18.0/0.18.1（全量 `release:preflight --probes`：panel 96/96、pages 52、toast 7、drawer 15、cases 8、tiers 32、a11y、empty 11、smoke、sweep） |
| 兼容声明 | `engines.dsh: ">=0.2.2-rc.1"`、`dsh.compatibility.dshReleases: { "0.2.2-rc.1+": "compatible" }` |

> 结论：只在 **0.2.2-rc.1** 上做过端到端验证。0.2.2 正式版、以及 `<0.2.2` 均未验证。

> **装哪个通道**：只装 `@latest`。npm 的 `next` 通道长期指着 `0.2.2-rc.3`（2026-11-18 的预发布
> 调试图，已在 npm 上弃用），比 `latest` 落后十几个版本；0.9.16 起 `npm run verify:release`
> 会断言「`next` 不比 `latest` 旧」，把这类悬空挡在发版前。

## 2. 宿主接口依赖（宿主半边）

| 接口 | 我们怎么用 | 变更/缺失时的症状 |
| --- | --- | --- |
| `export const inject = ['tools','systemPrompt']` | 插件声明必须的服务 | 插件不加载；面板消失 |
| `ctx.systemPrompt.section({ name, order, text })` | 注入 `studio-protocol`（order 70），告诉 agent 如何用 `studio_*` 工具 | agent 不写讨论、不推进卡片 |
| `ctx.tools.register(tool)` ×47 | 全部 `studio_*` 工具（建卡、派单、门禁、发布…） | 工具消失；LLM 报 unknown tool |
| `ctx.inject(['webServer'], ctx => ctx.webServer.register({ kind:'prefix', path:'/studio-api', handler }))` | 所有 HTTP 路由（135 条，含 `/suite/*`、`/coding/gitlab`、`/requirement/impact`、`/task/design`） | 前端全 404，面板空壳 |
| `ctx.get('connection').requestRejection(req)` → `401 \| 403 \| undefined` | `/studio-api` 的**信任栅栏**（判定在 `src/host/access.js` 的 `trustRejectionOutcome`）：Host/Origin 不对回 403（DNS rebinding、跨站），没有已认证的浏览器会话回 401；公开自助提单页与 `/health` 只豁免 401 | 服务不存在时**放行并记一行 `console.warn`**（栅栏本次未生效）——不退回「只信回环」，因为拿不到宿主那份可信 Host 名单，那样会把局域网里正常打开面板的人一起挡成 403。**必须以方法形式调用** `connection.requestRejection(req)`：抽成裸函数会丢 `this`，于是所有请求都判 403（dsh-pocket 的 issue #117 踩过） |
| `ctx.inject(['agents','sessionController','workspaceRegistry','permissionPresets','agentDefaultModel'], …)` | 派单引擎 `Dispatcher`：起会话、发指令、收 `agent/status` 事件 | 派单报「这一列还没人负责」或会话永远 idle |
| `workspaceRegistry.create(dir, title)` + `workspace.attachSession(sessionId)`、`workspaceRegistry.list()` / `resolveByPath(dir)` | 派单会话落在哪个工作区：**`create` 只把目录登记进工作区列表，`attachSession` 才把会话放进它的名单**。宿主的成员资格是显式名单——只在注册表首次初始化时按会话头 cwd 归组一次，此后不再自动归组。启动时 `healWorkspaceMembership()` 读会话头把 `studio-*` 老会话按 cwd 补挂回去（候选由 `src/host/dispatch-cwd.js` 的 `workspaceAttachPlan` 算） | 只 create 不 attach：会话跑在项目目录里，侧栏却一直显示「未分组」（2026-11-23 那轮只修了 cwd，就是漏了这一步）。attach 失败只记一行「会话没能挂进工作区（侧栏会显示「未分组」）」，不影响派单 |
| `ctx.get('sessionPersistence').list()` → `snapshot.header`（`id` / `cwd`） | 启动自愈时读所有已存会话的头部，决定哪些该补挂 | 服务缺失或改名时自愈直接跳过（返回 0），没有副作用；工作区列表读不出来时只记一行「读工作区列表失败」 |
| `ctx.agents.create / resume / get / list / abort` | 一卡一会话（`studio-<taskId>-<expertId>`） | 会话起不来；`has no provider/model`；槽位泄漏 |
| `ctx.agents.create({ agentOptions:{ provider, model }, setup })` + `agentPresets.resolve(id)` + `presets.mount(scope, id)` | 三件缺一不可，否则没有 shell/文件工具 | agent 只会说话、改不了代码 |
| `agent.inject()` + `agent.followup(text, { source:{ kind:'user' } })` | 真正驱动一轮 | 会话建好立刻 idle，卡片没有讨论 |
| `ctx.effect(fn, label)` | 所有长生命周期资源（定时器、工具、section） | 热重载后重复注册 / 内存泄漏 |
| `ctx.on('agent/status', …)` | `idle` 时结算槽位 | 并发闸门卡死 |
| `ctx.on('approval/request', (req, next) => …)` | 派单会话的提权审批由平台代答（自动批准 / 自动拒绝，口径在 `src/host/escalation.js`），每次写成卡上评论 | 监听不到就退回宿主默认「问人」：无人值守时整轮挂死（真机踩过 3 小时），或者提权请求被静默拒绝 |
| `ctx.get('approval').setPolicy(agent, 'ask')` | 派单时把审批策略显式设成 `ask`，否则 `approval: never` 的部署里请求到不了平台，「自动批准」成摆设（`danger-full-access` 跳过） | 服务/方法不存在时只记一行日志、不影响派单；代价是该部署上提权一律被静默拒绝（卡上只有工具自己的报错） |
| `node:sqlite`（`DatabaseSync`） | 状态库 `~/.dsh/dsh-studio.db`（WAL、`meta.state`、10 份快照） | 启动即崩；数据不落盘 |
| `llm.listModels(provider.id)`（模型下拉） | `/models` 端点 | 模型列表为空 |
| `ctx.inject(['sessionProjections'])` → `stateOf(session, 'tokenMeasurement')` | 派单收尾（`dispatcher.settle`）趁会话还活着取引擎自己的 token 计量，落到卡的 `insight` | 取不到就只是少一行「引擎计量」，不影响派单；宿主改名/改签名时报 `session.snapshotEvents is not a function` |
| `ctx.provide('featured-plugins', registry)` / `ctx.get('featured-plugins')` | 精选插件生态（`src/host/featured-source.js`）：首个激活的接入插件提供该跨插件服务，dsh-studio 登记推荐源 `FEATURED_SOURCE` 并挂聚合路由 `GET /dsh-plugins-plugin/featured`（`kind:'exact'`） | 服务不存在/路由被占时静默退化为纯登记方或仅数据方，**不影响面板与派单主流程**；精选入口只少一块目录 |

已知会直接暴露的宿主错误文案（排障关键词）：

- `dsh web authentication required` —— 反代丢失/改写 `Host`，cookie 绑定 authority
- `No available channel for model <model> under group arch (distributor)` + `status 503` —— provider 对该模型无通道，重试 5 次后整轮失败且**不写评论**
- `<agentId> has no provider/model` —— 起会话时漏传 `agentOptions`
- `no route POST /task/move` —— 前端调了后端不存在的路由（只在浏览器 console 可见）
- `session.snapshotEvents is not a function` —— `sessionProjections.stateOf()` 第一个参数传了字符串；它要的是**活会话对象**（`ctx.agents.get(sessionId)?.session`）

### sessionProjections 的实测契约（2026-11-16 探针结论）

- 服务名：`sessionProjections`；`registrations` 是 Map，8 个注册项：
  `turnBoundary / sandboxMode / approvalState / tokenMeasurement / subagentModelSelectionPolicy / sessionStats / turnOutline / userQuestions`，
  每项值形如 `{ def, cells, refs }`。
- `stateOf(session, key)` 两个参数，第一个必须是活会话对象；传 id 会抛错。
- `tokenMeasurement` 的内容（实测）：
  `{ headerSeq, stepStart, anchor: { assistantTokens, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens } }, invalidSeq }`。
  它给的是**token 总量**，**没有**「工具 vs 助手 vs 输入」的构成拆分。
- `register` 是 native 实现（`function () { [native code] }`），传任何形状都返回 Promise、不报错——**猜契约要靠试错，别在生产上试**。

## 3. 宿主接口依赖（浏览器半边）

| 接口 | 用法 | 失效症状 |
| --- | --- | --- |
| `window.__ModuleLoader__.load({ id:'dsh-studio', factory })` | 客户端模块注册入口 | 面板不出现 |
| `require('react')` / `require('react-dom')` | 使用宿主模块表里的 React（**不打包第二份**） | 白屏 / hooks 报错 |
| `ctx.slots.inject('main', …)` + `ctx.slots.register({ name:'main', key })` | 中央页面 | 页面空 |
| `ctx.slots.inject('sidebar.panellist', …)` + `register({ id, order, label })` | 侧栏入口「需求&任务工作空间」 | 侧栏没有入口 |
| `ctx.slots.inject('plugins.tab', …)` + `register({ name:'plugins.tab', id:'dsh-plugins-plugin', locale })` | 精选插件入口 tab（`client.src.js` 的 `installFeatured`）：未装完整版时引导一键安装 `dsh-featured`，已装则经 `window.__DSH_FEATURED_FULL__` 让位 | 槽位缺失只是没有精选入口；已装完整版时本入口自动让位，不会出现双 tab |
| `ctx.locale.register(NS, dict)` / `ctx.locale.bind(NS)` | 精选入口文案走 `dsh-plugins-plugin` 命名空间（内置 zh/en 兜底） | locale 服务不可用时退回内置中文文案，不影响注册 |
| 宿主 CSS 约定 | 我们所有 DOM 挂在 `[data-dsh-studio]` 下，弹层额外带 `data-dsh-studio-portal` | 样式失效、弹窗不可见 |

## 4. 运行时依赖（目标机）

| 依赖 | 用途 | 检查 |
| --- | --- | --- |
| `node >= 22`（实测 24.22.2） | `node:sqlite` 需要 | `node -v` |
| `git` | 一卡一 worktree、执行记录核对（`git rev-parse/log/diff`） | `git --version` |
| `unzip` | 上传 `.zip` 技能包 | `unzip -v` |
| `lark-cli` | 飞书云盘/文档归档（user 身份令牌） | 面板「飞书授权」状态 |
| 网络可达 GitLab | MR 回写、流水线状态 | 「集成健康」四通道 |
| `systemd` 单元 `dsh-web` | 常驻与重启 | `systemctl is-active dsh-web` |

文件布局：插件目录由安装方式决定（npm 装在 profile 的 `node_modules`，本地开发是 `~/dsh-studio`），数据 `~/.dsh/dsh-studio.db`、密钥 `~/.dsh/dsh-studio.secrets.json`、技能 `~/.dsh/skills/<name>/SKILL.md`、会话日志 `~/.dsh/sessions/<workspace>/studio-*/session.v4.jsonl.zstd`。

## 5. 升级 dsh 的验证 runbook

按顺序做，任何一步不符合期望就停下，不要继续往下：

1. `dsh --version` 记录新版本；`systemctl restart dsh-web` 后 `systemctl is-active dsh-web` 应为 `active`。
2. `curl -s -o /dev/null -w '%{http_code}' http://<host>/studio-api/state`（带 cookie）应为 `200`，且 JSON 有 `revision`、`tasks`。
3. 打开 `http://<host>/`：侧栏出现「需求&任务工作空间」，点进去 `[data-dsh-studio]` 渲染，`console` 无 error。
4. 工具数：`/studio-api/state` 之外，问 agent「你有哪些 studio 工具」应能看到 `studio_task_create` 等；或查 `/studio-api/tools` 若存在。
5. 派单一次：在看板对一张卡点「马上处理」，30 秒内该卡「讨论」应出现 agent 消息。没有 → 读会话日志找 `turn/end reason.kind=error`。
6. 门禁：把一张未勾清单的卡推向「已完成」，应返回 400「准出没过：…」。
6.1 设计闸门（若已开启）：设置 → 列的负责人 打开「设计闸门」，把一张没有评审记录的卡推进 `dev`，应返回 400「进开发被拦：…」。
6.2 回归：用例页点「▶ 跑」默认套件，回归历史应新增一条，且 `/studio-api/state` 的 `revision` 递增。
7. 拖拽：卡片拖到相邻列，`/studio-api/state` 里该卡 `status` 变化。
8. 若任何一步失败，`journalctl -u dsh-web -n 100 --no-pager` + 浏览器 console + 会话日志三处取证，再决定是降级 dsh 还是适配本插件。

## 6. 兼容矩阵

| dsh 版本 | 状态 | 备注 |
| --- | --- | --- |
| 0.2.2-rc.1 | ✅ 端到端通过 | 当前生产 |
| 0.2.2 正式版 | ⚠️ 未验证 | 升级前必须走第 5 节 runbook |
| 0.2.1 / 0.2.0 | ❌ 未验证 | 早期接口差异未知 |

## 7. 已知限制与未验证项

- **LDAP**：公司 LDAP（`ldap.<公司域>:389`）从目标机不可达（解析到内网地址，ping 全丢），只做过本地 slapd 联调；线上登录实际走「本地超管」（`admin` / 默认口令，scrypt 存储）。
- **GitLab**：公司 GitLab（`git.<公司域>/<group>/<repo>`）未配置真实令牌（需 Role Developer+ 与 `api` scope），MR 回写只做过离线/模拟验证。
- **发布门禁**：`releaseGate` 硬拦截不能被 `force` 跳过（`force` 只跳过规则项且必须给 `forceNote`）——这是设计选择，不是缺陷。
- **UI/设备自动化**：POS（Windows/Android）真机自动化未接入。
- **无障碍**：键盘可达性补丁已上线（`data-kb`/Enter/Space）；Windows 高对比度 `forced-colors` 只写了样式，未实机验证。
- **多实例**：派单互斥靠 SQLite `locks` 表租约（TTL 12s），只验证过单实例 + 手工模拟双实例，未做真实多进程压测。
- **性能**：`/studio-api/state` 原来 1.29 MB（21 张卡，2026-11-13）、gzip 497 KB；已开 gzip、15s 轮询 + 数据指纹判重。2026-11-13 起**交付物正文**（`/task/artifact` 的 `get`）、**评论**（`/task/comments`）、**用例与验收清单**（`/task/parts`）都改成按需取，整包降到 **170 KB（-86.8%）**、gzip **47.7 KB（-90.4%）**。卡片数这一层 2026-11-17 也补上了：看板**每列先渲染 40 张**，其余走「显示更多」按 40 递增（不是一次铺开，1000 张卡的 DOM 里只有 320 个卡节点，真 Chrome 实测首屏 591ms）；轮询则用 **ETag + 304**——`/state` 的 ETag = 数据版本 + 观察者哈希，浏览器带上 `If-None-Match` 再来一次时服务端直接回 304、一个字节正文都不发，所以「没变化」的 15 秒轮询不再重传上百 KB。复现：`npm run verify:scale`（假宿主 + 真 Chrome，量整包大小 / 首屏时间 / DOM 节点数 / 304）。

## 模型与通道

- 宿主默认模型在部分 provider 上没有可用通道时，会话第一轮就会 `turn/end reason.kind=error`，日志里是 `No available channel for model … 503`。插件的兜底常量是 `FALLBACK_AGENT_MODEL = 'deepseek-v4.1-flash'`（`src/host/dispatcher.js`），不跟随宿主默认。
- 模型在 **会话创建时固化**：改专家模型不影响已有会话，要重启服务或删 `~/.dsh/sessions/<ws>/studio-*` 才会重建。
