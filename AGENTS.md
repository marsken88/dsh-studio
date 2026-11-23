# dsh-studio · 开发指南

给接手这个仓库的人（和 AI）看的操作手册。原则只有一条：**改动必须能在真实浏览器与真实 dsh 上验证，验证不出来的改动不算完成。**

## 1. 仓库结构

| 路径 | 是什么 | 谁能改 |
| --- | --- | --- |
| `index.js` | 宿主半边：`apply(ctx)`、47 个 `studio_*` 工具、`/studio-api/*` 路由、SQLite 存储、派单引擎、门禁 | ✅ 直接改 |
| `src/host/*.js` | 宿主层模块：`case-strength.js`（用例强度：`isExecutable` / `coverageStrength` / `meetsCoverageTarget`，纯函数；**把「能验的用例」和「只有标题的草稿」分开**，产品定义第 8 条的 ≥60% 门槛就是它）、`role-playbooks.js`（四棒工作手册：`DEFAULT_ROLES`（产品/架构/研发/测试的默认人设与交付标准，原先在 domain.js）、`COLLABORATION_BRIEF`（先读上游交接、逐条回应未决、给下一棒三句话、要谁配合就 @谁）、`productPlaybook` / `architectPlaybook` / `devPlaybook` / `reviewPlaybook` 与 `rolePlaybookFor(columnId, task, requirement)`；**按卡当前列注入，并带上「当前缺什么」的事实**（功能点缺验收、设计定没定案、执行记录/项目检查跑没跑）；domain.js 有 2000 行闸门，所以角色文案放这里）、`test-plan.js`（三层测试（单元 / 集成 / 端到端）的口径：`inferTier` / `tierOf` / `tierRows` / `testPlanSummary` / `testPlanGaps` / `applyTierDeclarations` / `publicCases`，纯函数；**用例显式 tier 或按断言推断**，三条线要么有可执行用例、要么由测试专家在测试计划里写明「不适用 + 理由」，卡的准出按它判定；`/state` 的 `caseTiers` 也是它算的，卡面不点开抽屉就能看到缺哪层）、`intervention.js`（人工介入统计：`actorKind` / `cardInterventions` / `requirementInterventions` / `automationRate`，纯函数；**自动化率与介入点只能从这里算**，产品定义第 13 条；**不加埋点，只读已有事实**）、`mention-note.js`（评审备注里的 @：`stripQuotedCode` / `publishNoteMentions`；**只有评论解析 @，评审备注（`/task/coding` 的 reviewNote、`/task/design` 的 note）不解析**——真机在评审里 @架构师 没反应就是这么来的；现在备注会补成评论再逐个派单，代码块与行内代码里的 @ 一律不算点名（引用别人的话不该再派一轮））、`model-drift.js`（派单会话的模型漂移：`isModelDrift` / `driftNote` / `sessionWorkspaceSlug` / `sessionDirOf`，纯函数；**宿主把模型固化在会话创建时**，改设置不影响老会话、`create` 撞到老会话还会静默 resume —— 真机就是这样「配 Flash 实际跑 Pro」跑了很久；dispatcher 每次派单前比一次，不一致就 abort + 归档会话目录 + 重建一次）、`agent-feed.js`（派单会话的执行播报：`parseStudioSession` / `readAssistantMessage` / `feedBody` / `createFeedBuffer` / `approvalNote`，纯函数；**把会话里的思考·回复·工具·实际模型汇成卡上的「执行中」评论**（15 秒节流、本轮结束立刻发），并把派单会话的提权审批写成卡上评论（怎么代答见 `escalation.js`）；以前架构师会话卡在 `plugin_manager` 审批上三小时，界面显示在跑、评论一片空白）、`escalation.js`（派单会话的提权审批：`sanitizeEscalation` / `escalationFor` / `escalationOutcome`，纯函数；**无人值守会话里的 DSH approval 必须由平台代答**：`allow` = 自动批准，等于「始终允许完全访问」（默认）、`deny` = 自动拒绝并写清理由，沙箱选 `read-only` 时一律拒绝；dispatcher 还会把审批策略显式设成 `ask`，否则 `approval: never` 的部署里请求根本到不了平台 —— 用户要的「有个地方配 / 始终允许」就是它，不用再把沙箱整个调成无沙箱）、`dispatch-state.js`（派单阶段判定：`dispatchPhase` / `isStalled` / `countStalled`，纯函数；**崩溃重启后「停摆」的形状靠它识别**，单测在 `tests/dispatch-state.test.mjs`）、`cases.js`（跨卡用例聚合与回归汇总：`collectCases` / `groupCaseKeys` / `summarizeRun`，纯函数）、`team-memory.js`（专家团的团级记忆，存 side 键）、`quality.js`（AI 质量：返工识别与按专家汇总，纯函数）、`gitlab-facts.js`（执行记录 vs MR 事实的对账，纯函数）、`impact.js`（需求改版的影响面：受影响的卡与要重跑的用例，纯函数）、`route-contract.js`（HTTP 写路由的入参白名单：`declareRoute` 登记、`rejectUnknownFields` 校验；**只对字段少、形状明确的路由启用**，面板 payload 已逐条 grep 对齐）、`parallel-guard.js`（并发派单的隔离护栏：**并发 > 1 必须配 worktree**，否则 `effectiveConcurrency` 把有效并发降到 1 并把原因写进派单状态 —— 隔离 `none` 时多张卡会在同一目录互相覆盖，以前完全没提示）、`dispatch-cwd.js`（派单会话跑在哪个目录、注册成什么名字的工作区：`projectContext` / `dispatchDirFor` / `worktreeBaseFor`，纯函数；**DSH 按会话的 canonical cwd 归属工作区**——会话跑在 `~/dsh-workspace` 就只能在侧栏「未分组」里，所以项目配了「本机代码目录」时派单直接跑到那个仓库里，worktree 也建在仓库内 `.agents/worktrees`，兜底目录的工作区名固定为「Studio 工作区」）、`doc-sink.js`（文档出口的纯逻辑：出口解析 `docProviderFor` / 主从 `docSinksFor` / 幂等键 `artifactDocKey` / 配置形状 `sanitizeDocsConfig`；**真源永远是 artifact，飞书与 WeKnora 都是投影**，both 时飞书为主、WeKnora 失败不阻塞登记）、`weknora-sink.js`（WeKnora 出口的 IO：`uploadToWeknora` 建 manual 文档 → 触发 reparse，**fetch 可注入**方便用桩测；失败只回 error 从不抛，`both` 时由调用方决定不阻塞）、`doc-sync.js`（交付物的出口分发：按 `docSinksFor` 决定投递到哪儿，**WeKnora 是主时失败才抛，both 时只记 error**；写飞书与渲染 Markdown 由 executor 注入，避免成环）、`drive-gc.js`（云盘孤儿目录判定：**只认「名字像 REQ-* 且台账没人引用」的文件夹**，项目目录/未知一律保留；纯函数，CLI 在 `tools/drive-gc.mjs`）、`cmd-args.js`（Windows 上经 `cmd.exe` 执行 CLI 的参数引号：`& | < > ^ %` 与空格都要包引号，配合 `windowsVerbatimArguments` 才不被 cmd 当语法截断 —— 真机两次踩到：云盘 `--page-token` 里的 `|`、交付物标题里的 `&`）、`lark-upload.js`（lark-cli 的 markdown 上传参数：**`--file` 只给文件名、cwd 指到临时目录** —— lark-cli 只认当前工作目录子树，传绝对路径会被判 `unsafe file path`，2026-11-20 真机踩过，交付物同步全线失败）、`split.js`（把需求的功能点拆成卡：`splitRequirement` / `splitWarnings`，**路由与 studio_requirement_split 共用**；门禁照旧——评审通过 + 澄清答完才让拆，卡的验收清单 = 功能点的 acceptance）、`drive-folders.js`（云盘目录结构的纯函数：项目/需求/产物子目录的命名、同层同名复用判定、非法字符清洗）、`drive-sync.js`（云盘目录的建与删：根 → 项目 → 需求 → 按类型分类的产物，**建之前先列同名复用**；`larkJson` 由调用方传入，避免与 executor 成环）、`requirement-comments.js`（需求级评论的数据形状与增删改：`sanitizeRequirementComments` / `appendRequirementComment` / `updateRequirementComment` / `removeRequirementComment`；需求以前没有对话渠道，讨论只能覆盖正文或散到卡上，见 issue #115）、`comments.js`（评论的改与删：`updateTaskComment` / `removeTaskComment`，**改删都留历史**；评论是 agent 读卡时的主要输入，写错/重复/过时的必须能改 —— issue #19）、`reviews.js`（需求评审 / 设计评审 / 引用归一化：`resolveRequirement` 认编号与内部 id、`reviewRequirement`、`saveTaskDesign`；**路由与工具共用这一份**，issue #9 第 2、4 条）、`design.js`（设计多稿与定案 + 进开发前的闸门，纯函数；**「评审通过」≠「定案」**：多稿必须指认 `chosenId` 才放行，老数据只有 `link` 时在 store 加载期归一成一稿）、`shell-runner.js`（shell 用例执行器，默认关闭）、`shell-case.js`（shell 用例的数据形状，纯函数）、`runners.js`（用例执行器注册表：match + run，加新执行方式不用动 runOneCase）、`browser-runner.js`（浏览器用例执行器：真开 Chrome/Edge 走一遍页面，**默认关闭** `config.testing.allowBrowser`，形状 + 执行都在这里）、`url-guard.js`（出站地址守卫：host 白名单与相对地址解析，**接口用例与浏览器用例共用一套**）、`card-quality.js`（项目检查的数据形状与命令解析：`qualityFields` / `sanitizeQuality` / `qualityTargetFor`，纯函数；**服务优先、项目兜底、cwd 优先卡的 worktree**）、`quality-runner.js`（项目检查执行器：跑本地质量命令，超时/退出码/输出尾部；**准出里唯一的「机器跑出来的证据」**）、`merge-gate.js`（合并门禁：`mergeGateFor` / `sanitizeMergeGate` / `mergeGateLine`，纯函数；**和准出分开——合并看证据（评审/用例/项目检查/代码事实），验收看人（清单/签字）**；结论由 `publishMergeGate` 发成 GitLab 提交状态）、`release-model.js`（版本门禁与发布说明：`releaseGate` / `releaseNotes`，纯函数；**审批是 blocker，不是提示**）、`skill-shape.js`（技能的数据形状：名字规则 / 清洗 / SKILL.md 读写，含 **projects 项目范围**）、`skill-usage.js`（技能使用证据：哪些卡被挂了该技能的专家接手、其中多少张被打回；**只读台账，不加埋点**，返工口径复用 `quality.js` 的 `taskRework`）、`skill-mine.js`（技能沉淀：把一张卡上的**真实证据**（验收锚点/跑过的命令/踩过的坑/改动面）压成 SKILL.md 草稿，**默认停用**；没有证据的卡拒绝沉淀，不做推断）、`limits.js`（数量上限的默认值与清洗，可配置）、`db-runner.js`（SQLite 用例执行器与数据形状，默认关闭）、`discovery.js`（需求澄清必答项与拆卡门禁，纯函数）、`profile-detect.js`（`isStudioProfile`：依赖表/bundle 里认不认得出本插件；**认 scoped 名**，issue #5 第 2 条）、`tool-access.js`（每个 studio_* 工具的权限档位 + `toolLevel`；**契约测试要求 47 个工具全部登记**，漏登记会退化成 write —— issue #5 第 1 条）、`acceptance.js`（验收条件：`sanitizeAcceptanceItem` / `checklistFromAcceptance`，纯函数；**拆卡继承 / 用例挂条件 / 矩阵逐条判**的锚点）、`handoff.js`（交接契约：决策 / 假设 / 未决 / 风险 / 影响面的清洗与派单提示词渲染，纯函数；**派单先读契约再看评论尾 6 条**，产品定义 V1 必做 #5）、`delivery.js`（交付节奏三把尺子：门禁一次通过率、派单周活、需求交付时长，纯函数；口径写在文件头，产品定义 #9/#10/#14）、`event-ledger.js`（事件账本：单调 seq、保留最近 500 条、按 since 查询，纯函数；**先落账再投递**，产品定义第 7 条）、`featured-source.js`（精选插件生态集成：向跨插件 `featured-plugins` 服务登记推荐源、首个激活方挂聚合路由 `GET /dsh-plugins-plugin/featured`；**接入只提供入口，是否上榜由 skillpie.cn 收录决定**，见 `src/host/featured-source.js` 头注与 tests/featured.test.mjs）、`idempotency.js`（入站幂等：Idempotency-Key 校验、24h TTL、先到先得，纯函数；**重复 POST 只执行一次**，产品定义第 5 条）、`override.js`（绕过准出的结构化记录，纯函数）、`bugs.js`（失败用例 → 缺陷卡严重级别，纯函数）、`bitable.js`（卡片 → 飞书多维表格记录，分批 200，纯函数）、`context-insight.js`（上下文洞察：窗口峰值 / 回合 / 工具 / 重试 / 压缩点，纯函数）、`artifact-image.js`（交付物截图读取：只认白名单目录与图片扩展名）、`lark-doc.js`（飞书文档正文解析：把 lark-cli 的 fetch 输出变成 {ok,title,text,error}，纯函数）、`usage.js`（会话用量解析与计价，纯函数）、`session-usage.js`（读 session.v4 日志并按卡/专家汇总）、`events.js`（进程内事件总线，同步扇出）、`webhooks.js`（事件 → 出站 webhook，失败不重试）、`access.js`（权限判定：`checkAccess` / `accessLevelFor` / `READ_ONLY_POST_ROUTES`，纯函数；超管豁免只认服务端认定的身份、名字精确匹配）、`users.js`（登录过的人与 `ACCESS_ROLES` 的数据形状；从 domain 抬出来）、`audit.js`（审计条目形状：只留摘要，不记正文与密钥；从 domain 抬出来）、`domain.js`（板列/数据形状/`sanitize*`/默认配置，纯函数）、`intake-pages.js`（公开提单/查询页的静态 HTML，不依赖前端构建）、`dispatcher.js`（派单引擎）、`executor.js`（用例执行、代码事实核对、健康检查）、`requirement-gate.js`（需求准出：`requirementMatrix` / `requirementGate` / `requirementProgress`，纯函数；**60% 可执行覆盖是 blocker**）、`sessions.js`（登录会话键：token 的 SHA-256、内存表按哈希键查找、旧原始 token 自动迁移；**台账只存哈希，不存明文**）、`store.js`（`StudioStore`/`SecretStore`：SQLite 台账 + 快照 + 登录会话）、`integrations.js`（GitLab / 飞书 / 平台健康）、`routes/*.js`（按前缀拆出的 HTTP 处理：`exports.js` 导出 CSV、`auth.js` 统一登录、`tasks.js` 卡片/专家/列、`requirements.js` 需求/文档/公开提单、`releases.js` 版本/灰度/部署、`insights.js` 指标与工作台、`state.js` `/state` 的 ETag 与 304、`skills.js` 技能库读写上传、`admin.js` 配置/权限成员/审计/快照、`connect.js` 市场/集成健康/GitLab/仓库/飞书、`agents.js` 派单运行态与起停、`coding.js` 执行记录/失败重试/worktree/项目配置、`tools.js` 47 个 `studio_*` 工具） | ✅ 直接改，新逻辑优先放这里 |
| `client.src.js` | 浏览器半边的手写源码（通过 `window.__ModuleLoader__` 注册面板） | ✅ 直接改（前端逻辑） |
| `web/src/**` | shadcn/Radix 组件、样式、`legacy.js` 桥；`web/src/studio/*.js` 是从 `client.src.js` 抬出来的纯模块（`markdown.js` 渲染器、`format.js` 日期格式、`labels.js` 标签表、`roster.js` 负责人与候选人、`fields.js` 表单适配层、`shell.js` 共享抽屉、`card.js` 看板卡片、`board.js` 看板本体、`mentions.js` @ 选择器、`cases.js` 多步用例解析、`drawer.js` 卡片详情抽屉、`editor.js` 通用编辑器、`palette.js` 命令面板（⌘K 全局搜索卡片/需求/版本/专家/专家团/项目/技能 + 动作项 + Ctrl/⌘+Alt+Shift+N/T/D 全局快捷键；带 Shift 是为了避开宿主的 Ctrl+Alt+N 新会话）、`charts.js` 进度条与燃尽图、`context.js` 共享上下文（`provideClient`/`client`）、`panels/*.js` 设置页 18 个面板、`pages/*.js` 七个页面组件（看板之外的工作台/需求/用例/版本/项目/效能/自助提单）；**`StudioPage` 是组合根，故意留在 `client.src.js`**，它负责顶栏、页签与「＋ 新建」菜单并调用 `provideClient()`，别为了行数把它搬走），由 `make-legacy` 生成的 `legacy.js` 顶部统一 import | ✅ 直接改（样式与组件） |
| `dist/client.js` | `pnpm build` 的产物（单文件 IIFE，注意在仓库根 `dist/`，不是 `web/dist/`） | ❌ 生成物 |
| `client.js`（包根） | 上面产物自动同步过来的副本，dsh 真正加载的那个 | ❌ 生成物 |
| `cordis.patch.yml` | bundle patch，把本包挂进 profile | ✅ |
| `locale/*.json` | 面板标题/描述等元数据 | ✅ |
| `README.md` | 用户向文档（安装、功能、排障） | ✅ |
| `docs/compatibility.md` | 我们对 dsh 宿主接口的依赖清单与升级 runbook | ✅ 改动宿主调用时必须同步 |
| `docs/quickstart.md` | 第一天上手：clone → 测试 → 构建 → 部署 → 冒烟，每条都在全新 clone 上验过 | ✅ 命令变了就同步 |
| `docs/publish.md` | 发布到 DSH 插件市场：发版、收录条目结构、自查清单 | ✅ 改发版流程时同步 |
| `docs/history.md` | 按日期归档的实现流水账（体检、补完、UI 收尾），从 README 移出来的 | ✅ 只追加，不改历史 |
| `docs/auth.md` | 登录与免登录（LDAP / 本地超管 / 会话落库），从 README 拆出来 | ✅ 改登录逻辑时同步 |
| `docs/ui.md` | 界面实现记录（shadcn 对齐 / 构建链 / 布局一致性 / 暗色巡检） | ✅ 改前端构建或样式体系时同步 |
| `docs/manual.md` | **使用说明（人与 AI 共用）**：对象模型、一条需求的旅程、六道门禁、47 个工具的用法、设置项地图、数据在哪、**排障手册（症状→先查→怎么修）**、日常运维命令 | ✅ 用户能感知的行为变了就同步；排查经验也往 §8 里加 |
| `docs/product.md` | **产品定义**：目标用户、核心场景、V1 范围与暂缓事项、可观察验收标准、落地顺序 | ✅ 改范围或验收口径时同步；新功能先看这里决定做不做 |

## 2. 三个前端文件的关系（最容易搞错的地方）

```
client.src.js              手写源码
      │  web/scripts/make-legacy.mjs  →  web/src/legacy.js
      ▼
web/src/**  ── vite build ──▶  dist/client.js  ── sync-client.mjs ──▶  根 client.js
```

- 改**前端逻辑** → `client.src.js`
- 改**样式/组件/主题** → `web/src/**`
- 改完一律在 `web/` 里构建：`pnpm build`（= `make-legacy` → `guard --pre` → `vite build` → `sync-client` → `guard --post`）
- 构建后自检：`cmp -s dist/client.js client.js && echo same`，大小约 1.38 MB（gzip ≈ 402 KB）

> 曾经漏跑 `make-legacy`，`client.src.js` 的改动根本没进 bundle，白改好几轮。构建脚本已经把它串进 `build`，不要手工跳过。

## 3. 构建与部署

```bash
# 1) 构建（Windows 上用随包 pnpm）
cd dsh-studio/web
node C:/Users/hp/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs run build

# 2) 部署：一条命令，传 index.js + dist/client.js + 整个 src/host，先备份再覆盖，最后自检
cd ..
DSH_DEPLOY_HOST=<host> DSH_DEPLOY_USER=<user> DSH_DEPLOY_PASSWORD=*** node tools/deploy.mjs
#    没有密码就先用 --key 或 ssh-copy-id 授权本机公钥，再：node tools/deploy.mjs --dry-run 看它要传什么

# 3) 冒烟：进面板 → 页签 → 看板有卡 → 用例库有行 → pageerror 必须为空
STUDIO_TOKEN=$(sudo journalctl -u dsh-web -n 50 | grep -o 'token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2) \
  node tools/visual/smoke.mjs
```

> `tools/deploy.mjs` 会打印 `version=` / `restart=` / `active=` / `files=` / `state=`：
> `active` 不是 active 退出 1；**文件传上去了但服务没重启退出 4**（key 模式下 sudo 要密码时就是这种）。
> 只想传文件不重启用 `--no-restart`。元数据（`package.json` / `cordis.patch.yml` / `icon.svg` / `README.md` / `locale/*.json`）现在跟主文件一起传。
> 它依赖 `ssh2`（devDependency，只给部署用，不进插件运行时）；`tools/mock-gitlab.mjs` 是本地 GitLab 打桩（三个接口，3 文件 / 3 提交），配合 `tools/verify-gitlab-facts.mjs` 可以在没有真实令牌时把「MR 事实 → 与自报值对账」整条链跑通：`node tools/mock-gitlab.mjs` + `STUDIO_BASE=<host> node tools/verify-gitlab-facts.mjs`。

`tools/visual/smoke.mjs` 依赖 `puppeteer-core`（同样只在 devDependencies 里），浏览器用系统 Chrome，可用 `CHROME_PATH` 指定。

> **本地开发挂进 profile 要两处都写**：`package.json` 的 `dependencies`（`link:<repo>`）**和** `dsh.profile.bundles` 数组。
> 只在 dependencies 里出现不会加载 —— profile 的插件树按 bundles 逐层合成，2026-11-19 我就这么白重启了一次。
> 装完还要把 `index.js client.js package.json cordis.patch.yml locale src` 放进 `node_modules/@marsken/dsh-studio`
> （Windows 无管理员权限建不了符号链接时直接拷），然后重启。**日常用 `npm run sync:profile` 做这一步**：
> 它先把「仓库版本 → profile 版本」打出来再拷（2026-11-20 就是靠这一行才发现 desktop profile 里躺着 0.9.14 的拷贝，
> `link:` 根本没建成链接，白重启了一次），目录整体替换，不会把删掉的模块留成旧文件。
>
> 目标机上那个老的 `deploy-all.sh` 只作兜底（它拷 `/tmp/` 下的两个文件和 `src/`）。日常用 `tools/deploy.mjs`，别再手工 scp 拼路径。`package.json`（包头、`engines`、`dsh.*`、`files`）、`cordis.patch.yml`、`locale/*.json` 由 `tools/deploy.mjs` 一起传（2026-11-22 起）；只有走 profile 的 `node_modules` 手工拷贝时才需要自己带。改动前先 `cp package.json /tmp/package.json.bak` 留退路。
>
> 宿主拆成 `src/host/*.js` 以后，**部署必须带整个 `src/` 目录**：`/tmp/index.js`、`/tmp/client.js`、`/tmp/src/host/{domain,dispatcher,executor,integrations,store}.js` 与 `/tmp/src/host/routes/*.js`。只传 `index.js` 会得到 `ReferenceError: sanitizeAccess is not defined`（服务 502）。

验收三件事：`systemctl is-active dsh-web` = `active`；浏览器打开 `http://<host>/` 侧栏出现「需求&任务工作空间」；`GET /studio-api/state` 返回 200 且 `revision` 递增。

## 4. 每次改动前后的硬性检查

1. `node --check index.js && node --check client.src.js`（语法；但**查不出**运行期 `ReferenceError`，见第 11 节）
   再加 `npm run verify:tdz`：作用域内“先用后声明”在浏览器里是 `Cannot access 'x' before initialization`（issue #6 就是空看板第一行读了还没初始化的 `filtering`，平时被 `&&` 短路掩盖）
2. 构建后 `cmp` 两个 client.js 一致
3. 服务端行为：写一个 `tmp/*.mjs`（或 `.py`）脚本直接打 `/studio-api/*`，**不要在 PowerShell 里内联复杂 `node -e`**
4. UI 行为：先跑 `node tools/visual/smoke.mjs`（部署后冒烟，见 §3）；要验具体功能就照它的写法加探针，必须
   - 先点侧栏文字进入面板，再等 `[data-dsh-studio]`
   - 切页签用 `elementHandle.click()`（Radix Tabs 不认 DOM `.click()`）
   - 断言 DOM + `pageerror` 为空，并截图留档
   - **能创建的东西必须有能用的路径**：新加一种对象或执行方式，要同时给「怎么建」和「怎么用」两个入口，探针必须走完「创建 → 使用 → 看到结果」。反例：2026-11-14 的 shell / 数据库用例，抽屉里建得出来，但「▶ 跑」按钮只认接口用例，另外两种永远跑不了——功能加了两天没人发现。
   - **探针说「找不到元素」时，先截图再说**：面板崩掉时 React 的错误边界会把异常吞在自己的渲染树里，`pageerror` 是空的，页面上只有一行「工作空间渲染失败：xxx is not defined」。2026-11-13 连着两次把「页面崩了」误判成「选择器不对」，白跑两轮。截图 + `document.body.innerText.includes('渲染失败')` 才是判据。
5. 涉及权限/门禁/发布的重改动，跑一遍既有 e2e 脚本并贴出数字
6. `npm test`，**并且再跑一次 `TZ=UTC npm test`**：CI 在 UTC 里跑，本地在 Asia/Shanghai；写成 `new Date('2026-11-16T00:00:00+08:00')` 这种字面量会「本地绿、CI 红」（0.8.0 就是这么挂的）。测试里一律用本地构造器 `new Date(2026, 10, 16)`。（条数以 `npm run check` 打印的为准，别再写死数字；覆盖范围是：`tests/repo.test.mjs` 管 manifest / 产物一致 / 宿主接口 / 领域层拆分与导入 / **导入只读绑定不许赋值** / **跨模块符号必须导入** / 迁移 / 文档 / locale / **用了 `React.` 的组件必须从 `client()` 或工厂参数拿到 `React`**；`tests/client-units.test.mjs` 用真实模块跑标签表/负责人/日期/命令面板检索这些纯函数；`tests/notify.test.mjs` 起一个本地 HTTP 桩验证飞书通知（正文归一、`botWants` 的事件矩阵、`feishuBroadcast` 只发给订阅该事件的机器人）；`tests/store-boot.test.mjs` 真的起一个 `StudioStore`，把「搬完代码启动就炸」这类问题挡在部署前。想连真数据验证：把生产库三个文件（`.db`/`-wal`/`-shm`）拷到临时目录，用 `new StudioStore()` + `await store.ready` 跑一遍，`tmp/boot-real.mjs` 就是这么写的）；`npm run check` = 语法 + 契约一把过
7. 构建期守卫：`web/scripts/guard.mjs`（`pnpm build` 自动跑两次）——禁 CSS 里出现 `hsl(var(--x))`、禁 Radix Portal 不挂 `container={portalRoot()}`、产物里必须留下 `data-dsh-studio-portal`。单独跑：`cd web && npm run guard`
8. 真库自检：`npm run smoke:store -- ~/.dsh/dsh-studio.db`（把 `.db/-wal/-shm` 拷到临时目录起一遍真实 `StudioStore`，专抓「空库能起、真库就炸」的导入问题）
9. 成本数字可疑时跑 `npm run verify:usage [taskId]`：ssh 取原始会话日志现算一遍 token，与 `/costs` 对账（两条路径不同：一条走 session-usage 的 zstd 缓存，一条走 usage.js 直接解析）。
10. 发版后跑 `npm run verify:release`：比对 package.json 版本 / 本地 tag / origin main 与 tag / npm registry，
    并用 **gh** 检查这一版的 GitHub Release 建出来了、**正文不是占位句**（`release.yml` 的正文取自 CHANGELOG，
    少了这一版就只剩一句「没写更新日志」）。不一致直接退出码 1；本机没有 gh 或还没打 tag 时这两条只跳过、不判红。
    **查 registry 不要用 `npm view`**：它启一次 npm、拉完整 packument（0.9.30 时已 400 KB），冷机器上十几秒。
    改用 `tools/registry-latest.mjs`（dist-tags 端点，20 字节）与 `tools/registry-has.mjs`（单版本端点，200/404），
    两者都在 `tools/lib/registry.mjs` 上；刚 publish 完的边缘缓存延迟由 `REGISTRY_WAIT_SECONDS` 重试窗口兜住。
11. 全闭环自检：`STUDIO_BASE=http://<host>:18080 node tools/e2e-loop.mjs [--k 3]`——真建一条需求和卡，跑完澄清门禁→评审→拆卡→各列→代码事实→用例→验收→版本发布；每步都是断言，`--k` 连跑 N 轮看成功率（每轮约 35 秒），任何一轮失败退出码非 0。
    **默认跑完自动删除自己建的数据**（看结果加 `--keep`）。周检用 `npm run selfcheck`（= `--k 3`，连跑三轮看成功率）；定时任务在 2026-11-16 被用户主动删除，不要自动重建，需要时给一条 crontab：`0 9 * * 1 cd <repo> && npm run selfcheck`。
12. 提示词 A/B：`node tools/prompt-ab.mjs --task <卡 id> --variant '一段追加提示词'` 先看计划（免费），`--setup-only` 验建/删专家通路（免费），`--run` 才真派两次单（花 token）。判据是用例通过数 / 代码事实 / 评论数 / 耗时。
13. CI 在 `.github/workflows/ci.yml`：语法 → 契约 → `web/` 里 `pnpm install --frozen-lockfile && pnpm build` → `cmp dist/client.js client.js` → `git diff --exit-code`（产物必须可复现，改了前端忘记构建会直接红）→ `npm run verify:pages`（假宿主 + 真 Chrome：8 页渲染 + AX 命名 + aria-hidden 焦点检查 + 800px 顶栏回归，45 项）
    **推完就等这一提交的结论：`npm run ci:watch`**（= `gh run watch --exit-status`，本机已登录 gh）。
    它阻塞到流水线结束，绿了返回 0；红了自动打印 `--log-failed` 的尾巴，不用去网页翻。
    别再 `sleep` 轮询：以前那样每次多等 1~2 分钟，而且失败时拿不到日志（未认证的日志接口 403）——
    2026-11-20 连推 5 个提交全红就是这么漏掉的。指定别的提交：`npm run ci:watch -- --sha <sha>`。
    注意 `ci.yml` 现在会先 `pnpm install --frozen-lockfile --ignore-scripts` 再跑测试（浏览器用例要 puppeteer-core，ubuntu runner 自带 Chrome；ssh2 的可选原生构建不需要）；除浏览器用例外，其它契约测试仍要能在没有依赖时跑，别新增对 devDependency 的硬依赖。

14. **面板渲染探针**：`npm run probe:panel -- --base http://127.0.0.1:<dsh 端口>` ——
    用假宿主挂**真实 client.js** + 把 `/studio-api/*` 反代到正在跑的实例，puppeteer 逐页断言并截图（`tmp/probe/`）。
    **接口测试与单测看不见"渲染在哪个面板里"**：0.9.36 就把「评审闸门」开关插进了「数据与备份」面板，
    全绿但设置页看不到。探针自己造带「（探针）」标记的数据、跑完自删；没装 puppeteer-core 或没 Chrome 时**跳过不判红**。
    改判据：在 `tools/visual/panel-probe.mjs` 的 `check(...)` 列表里加，别写一次性脚本。
## 4.5 需求澄清（比代码更靠前的一道门）

- **不清楚就一直问，问到能一句话复述「交付什么、给谁用、怎么算完成」为止**。宁可多问三轮，也不要按猜测开工。
- 平台上的三问（有没有服务端 / 鉴权谁做 / 交付边界）是**最低要求**，不是全部；答完仍不清楚的继续问。
- **绝不把假设写成「遗留」**：遗留是双方认可的取舍，没问过的东西只能写成「待确认」，并且必须真的去确认。
- 反例（2026-11-15）：把「管理后台」理解成只做前端 + 内存 mock，还把「无真实后端」写进签收记录当遗留——用户看到的是"说好了不做"，实际是"根本没问"。

## 4.6 协作纪律（需求必须由专家做完，不是由脚本推完）

- **一条需求 = 一串专家接力**：产品澄清 → 架构方案 → 研发实现 → 测试验证，每一棒都要在卡上留下
  **评论 + 交付物 + 提交**。只改门禁状态、不派单的"流程演示"不算交付。
- **禁止用 API 伪造执行过程**：直接写 `coding`（files/commits 全空）、直接标用例 pass、直接签字——
  这叫"过流程"，不叫"做完"。真实需求一律走 `/agents/run` 派单。
- **演示数据必须标明是演示**：脚本造的卡（`tools/e2e-loop.mjs`、各种 demo）要能一眼看出是自检，
  不要混进真实需求的统计里（自检默认跑完自删）。
- **需求正文要能独立看懂**：背景 / 目标 / 范围 / **不做** / 验收 / 风险，六段齐全；一句话描述的需求会被拆成一堆没法验收的卡。
- 需求现在有自己的讨论区（`requirement.comments` + `/requirement/comment` + `studio_requirement_comment`，issue #115）：
  需求级的追问写在这里，卡上的评论仍是实现细节；两边都读，别只信一边。

> 反例（2026-11-16）：为了演示"完整流程"，我用 API 直接建需求、直接 approve、直接写执行记录、直接签字，
> 三张卡零评论零派单就"交付"了。用户一问"为什么讨论区没有多智能体内容"，才暴露这条路根本没走。
> 同一轮还撞出真 bug：`buildExpertPrompt` 里裸引用了 `activeSkills`，**只要专家配了技能就派不出去**——
> 因为演示从来没派过单，这个 bug 一直没被发现。

## 5. 禁止事项

- ❌ 手改 `dist/client.js` 或根 `client.js`（会被下次构建覆盖）
- ❌ 直接在目标机上改文件而不回写仓库（下次部署即丢）
- ❌ 用 `powershell -Command "node -e \"...\""` 这类多层引号跑逻辑；一律落成 `tmp/*.js|mjs|py`
- ❌ 用 `split("\r\n")` 编辑 README（本仓库是混合行尾）：用 `split(/\r?\n/)`，写回统一 `\r\n`
- ❌ 在 UI 线程里做「读样式 + 写属性」交替的批量循环（会触发强制同步布局，实测 685 ms 长任务）
- ❌ 删除用户数据前不备份：先 `cp ~/.dsh/dsh-studio.db /tmp/...`，再操作
- ❌ 从 `index.js` 往外搬代码后不回查导入：`node --check` 查不出，只有 `import()` 与运行时才会炸（新增的契约测试会拦一类，见 §4）

## 6. 后端约定（`index.js`）

- **工具入参严格**：`studio_*` 工具多传未知字段会被直接拒绝（白名单 = 工具自己声明的 `parameters`，两种写法都认），不再静默忽略。新增工具时把字段写进 `parameters`，否则调用方传了会被拒。
- **路由也有白名单**（`route-contract.js`）：字段少、形状明确的写路由（评论/清单/需求评审/需求签字/合并/合并门禁）多传未知字段直接 400；复杂形状（`/task/update` 传整张卡）仍宽松，新增这类路由时先想清楚字段。
- **写工具要回读**：`studio_task_create/update`、`studio_requirement_save`、`studio_task_artifact` 的返回值末尾带 `库里的记录：{...}`，是从 store 快照读的，不是回显入参。新增写工具照这个来。
- **白名单四处**（原来写的三件套少算了一处，2026-11-13 因此丢过 `config.design`）：`defaultConfig()`、**`mergeConfig(saved)`——重启加载时按显式键列表重建配置，没列进去的键会被静默抹掉**、`mergeConfig(patch)`/`publicConfig()`（可写 / 对外可见）、`sanitizeX()`（每个对象）。契约测试 `config: every default key survives a merge round trip` 会拦住漏掉的那处。
- `StudioStore.mutate(fn)` **返回整份 state**，不是 `fn` 的返回值；要拿某张卡用 `store.snapshot().tasks.find(...)`。
- 所有对外状态走 `publicState()`：`{ revision, config, tasks, requirements, releases, experts, … }`。
- **破坏性路由必须带 `confirm`**（`src/host/access.js` 的 `DESTRUCTIVE_ROUTES` + `needsConfirm`）：删数据 / 清审计 / 改权限 / 发布 / 回滚 / 装机共 20 条，值不对就 400 `confirm_required`。新增这类路由时两处都要加（路由表 + 前端 `web/src/studio/destructive.js`），并有契约测试兜底。
- 路由统一挂在 `/studio-api`（`ctx.webServer.register({ kind:'prefix' })`）；新增路由记得同时更新权限分级 `accessLevelFor` 与 `/auth/*` 例外。
- 迁移走 `config.schema` 版本号 + `#load()` 里的顺序迁移函数，禁止「就地猜测数据形状」。
- 长任务（派单、GitLab 同步、飞书推送）不得阻塞请求线程；失败要写进任务 `history` 或审计，不许静默。
- 拆出去的模块要宿主能力时，用 `configureDispatcher()/configureExecutor()/configureIntegrations()` 注入（`store.js` 不需要注入，只依赖 `domain.js`），**不要让子模块反向 import `index.js`**（会成环）；需要活值（如 `activeDispatcher`）用 getter 注入。

## 7. 前端约定

- `client.src.js` 是**无 JSX** 的 `h()` 写法；需要 Radix 组件时用 `kit('Tabs')` 等取，取不到必须能降级（宿主可能没给）。
- 弹层一律用 Radix Portal，且容器**同时**带 `data-dsh-studio` 与 `data-dsh-studio-portal`，否则 `[data-dsh-studio]` 前缀的样式在弹层里全部失效（表现为「弹窗存在但看不见」）。
- 样式优先级：legacy 的 `.ds-*` 运行时注入，晚于 head 里的 Tailwind；同特异性时 legacy 胜。要覆盖就提高特异性（`[data-dsh-studio] .x`）。
- 颜色用**实色**，不要 `hsl(var(--primary))`（部分子树解析不到会让主按钮退化成纯文字）。
- 深色主题靠 `[data-theme="dark"]` 覆盖 `--ds-*` 变量；新增面板要同时给浅/深两套背景与边框。
- 表单统一用共享 `SideDrawer`；危险操作 `data-danger`，阻断/警示 `data-warn`，主行动 `ds-btn-primary`。

## 8. 宿主接口约定

- `export const inject = ['tools', 'systemPrompt']`；其它服务用 `ctx.inject([...], ctx => …)` 延迟获取，缺服务时整个插件不应崩。
- 起会话必须三件齐全：`ctx.agents.create({ sessionId, meta:{ cwd }, agentOptions:{ provider, model }, setup })`，其中 `setup` 要 `agentPresets.resolve(id)` + `presets.mount(scope, id)`；随后 `agent.inject()` + `agent.followup(..., { source:{ kind:'user' } })` 才真正驱动一轮。
- **模型在会话创建时固化**：改专家模型设置不影响已有会话，必须重启服务或删 `~/.dsh/sessions/<ws>/studio-*` 才会重建。
- 会话名固定 `studio-<taskId>-<expertId>`；排障时直接读 `~/.dsh/sessions/…/session.v4.jsonl.zstd`（`zstd -dc`）。
- 模型兜底不得跟随宿主默认（宿主默认在部分 provider 上没有可用通道，会 `503 No available channel`），统一走 `FALLBACK_AGENT_MODEL`。

## 9. 数据与迁移

- 真源：`~/.dsh/dsh-studio.db`（`node:sqlite`，WAL，`meta.state` 存整份状态，保留 10 份快照）；`~/.dsh/dsh-studio.json` 只是历史遗留。
- 密钥：`~/.dsh/dsh-studio.secrets.json`（0600）；不得写进 state、日志、README。
- 技能库：`~/.dsh/skills/<name>/SKILL.md`，插件启动时 `syncAll()` 自愈。
- 清库前必备份，清库后按场景重建（需求 → 功能点 → 卡 → 用例 → 交付物）。

## 10. 提交与发布

```bash
git remote -v          # origin = ssh://git@ssh.github.com:443/marsken88/dsh-studio.git
GIT_SSH_COMMAND="ssh -p 443" git push
```
- 一个提交只做一件事，标题一句话说清（英文或中文均可，与既有历史保持同风格）。
- **不许直接往 `main` 推代码**：一律 worktree 分支 → 测试通过 → 评审完成 → 提 PR → 合并 → 打 tag 发版。
  六步与每步判据写在 [`CONTRIBUTING.md`](CONTRIBUTING.md) §4；简称就是：**worktree 开发 → 测试通过 → 审核完成 → 提 PR → 合并主干 → 构建发布**。
  历史上直推 main 攒出过「远端、目标机、仓库三处不一致」，也出现过「没评审就进主干」。
- **工作树的隔离单位是「功能」，不是「消息」**：
  · **会话级**：每开一个会话，开发就在它自己的工作树里做（`create_worktree` / `git worktree add`），不要在主检出上改；
  · **功能级**：同一会话里做不同功能，各自开一个工作树、各自一条分支，别混在一起；
  · 同一个功能的连续小改继续用当前工作树，不用每句话都新开。
- **合并必须用户确认**：agent 把 PR 提好、CI 绿、证据贴全后**停下等人点头**；人没确认不合并、不打 tag、不发版。
- **打 tag = 用户点名发布**：代码合进 `main` 并部署到目标机之后就**停住**——不自己 bump 版本、不自己打 tag、不自己发 npm。
  只有用户**亲自验证过功能**并明确说「发布 / 发版」，才做「改版本号 + 改 CHANGELOG + 打 tag + 推 tag」。
  2026-11-23 我连着 22 个版本自己合并自己 tag（v0.9.78～v0.9.99），全部没等人验证，这是违规；这条写在这里防止再犯。
- **并行**：多个任务可以同时各占一个工作树并行开发；**改到同一个文件的任务不能并行**，要么串行、要么合成一个；每个 PR 合并前要先把自己的分支同步到最新 `main`。
- **先真机验证，再提 PR**：改完代码 → 构建（`pnpm build` + `cmp` 产物）→ 部署到目标机（`tools/deploy.mjs`）→
  在**目标机的真数据**上跑探针/截图确认没问题 → 把这份证据贴进 PR 正文 → 才提 PR。
  `npm test` / `verify:pages` 只是入场券，不能替代真机验证：假宿主夹具太简单，`PANE is not defined`、
  空态被 flex 压扁、`button{padding:0}` 吃掉内边距这几类问题都只在目标机暴露。
- **提 PR 之前必须先完成评审**（自查清单 + 证据贴进 PR 正文；有第二个人时由他 approve）。评审没完成就提 PR，等于把评审推迟到合并前一刻。
- 分支上改完就推分支（`git push -u origin <branch>`），PR 合并由人（或 `gh pr merge`）完成，**合并前 CI 必须绿**。
- **合并进 `main` 之后才打 tag**：`vX.Y.Z` 触发 `release.yml`（npm 发布 + GitHub Release）与 `publish-github-packages.yml`，发完用 `npm run verify:release` 核对「发版一致」。
- **合并即清理分支与工作树**：`gh pr merge <n> --merge --delete-branch`；然后 `git worktree remove .agents/worktrees/<name> --force && git worktree prune`；
  本地残留用 `git branch -d`（不用 `-D`），远端残留用 `git push origin --delete`。删之前先 `git merge-base --is-ancestor <sha> origin/main` 证明已合并 ——
  `backup/*` 这类备份分支**未合并**，按「备份」对待，不要当合并残留删掉。
- 提交前确保根 `client.js` 与 `dist/client.js` 一致（clone 下来即可安装靠的就是这一点）。
- 版本号在 `package.json`；发布标签 `vX.Y.Z`。

### 发布前必做（硬性，缺一不许发）

**每一次要发版（打 tag）之前，必须先把文档改完并一起提交。** 这条不是"尽量"，是门槛：
用户看的是 README 和 npm 页面，不是 `git log`。历史教训：0.2.0~0.2.3 连着发了四版，
README 里还写着旧行为（"安全边界"、"发版流程"、"探针清单"全都没有），版本号在三处
文档里各说各的（`package.json 0.2.3` / `CHANGELOG 0.1.47` / `docs/compatibility.md 0.1.47`）。

发布前逐项过一遍，缺哪项就补哪项：

| 检查 | 位置 | 什么情况下必须改 |
| --- | --- | --- |
| 用户能感知的行为 | `README.md` | 新增/改变了功能、命令、默认值、限制、安装或发版方式 |
| 更新日志 | `CHANGELOG.md` | 每个版本都要一条（只写用户能感知的，内部重构不写） |
| 兼容性声明 | `docs/compatibility.md` | 版本号、宿主依赖、已验证的 DSH 版本 |
| 界面/组件决策 | `docs/ui.md` | 换了组件、改了样式体系、新增本地补丁 |
| 探针清单 | `README.md` 的「质量闸门」 | 新增 `verify:*` / `review:*` 脚本 |
| 一致性（文档） | `npm run release:check` | 校验 CHANGELOG 有本版条目、compatibility 版本号一致、README 提到的脚本都存在；**若自上个 tag 以来改了代码却没改 README，直接失败** |
| 一致性（真机） | `STUDIO_TOKEN=… npm run release:preflight` | 文档检查 + **真机跑 pages / toast / drawer 三套探针**。接口类改动最容易「本地全绿、发出去才发现面板坏了」——0.3.1 就是这么把「保存角色模板」打成 400 的。CI 里没有部署和 token，所以这一条只在本地发 tag 前跑 |
| 一致性（产物） | `npm run verify:pack`（已自动包含在 `release:check` 里） | **验的是 npm pack 出来的 tarball**：patch 在包里、`name` 等于包名、`exports`/`dsh` 指向的文件都在、`index.js` 能被 import。0.5.1「装完不加载」这类问题在这里就会红 |
| 一致性（安装，周任务） | `dsh plugin --profile <临时 profile> install @marsken/dsh-studio@<版本>`，再 `--dump-config \| grep dsh-studio` | **每次发版前都要真装一遍**：0.5.1 及以前的 `cordis.patch.yml` 里写的是裸名 `dsh-studio`，从 npm 装完根本不加载（issue，2026-11-19）。探针打的是手工部署那份，抓不到这类问题 |
| GitHub Packages 镜像 | 独立 workflow `publish-github-packages.yml`，**按 tag 触发**发 `@marsken88/dsh-studio`（不再由 release.yml 调，那样会互相取消） | 镜像里 **package.json 的 name 与 `cordis.patch.yml` 的 name 必须一起改**，只改一处就是装了不加载 |
| GitHub Release | `release.yml` 自动建（正文取 CHANGELOG） | 打 tag 后要能在 Releases 页看到这一版；正文来自 `tools/changelog-section.mjs`，所以 **CHANGELOG 没写这一版 = Release 里只剩一句"没写更新日志"** |
| 一致性（发版） | `GIT_SSH_COMMAND="ssh -p 443" npm run verify:release` | 必须「发版一致」才算完 |

顺序固定：**改代码 → 改文档 → `npm test` → 构建并 `cmp` 产物 → 提交 → 打 tag → 推 tag**。
脚本改了但文档没改，等于把"怎么用"的答案留在上一个版本里。

## 11. 常见故障速查

| 现象 | 先查这里 |
| --- | --- |
| 页面白屏 | 浏览器 console 的 `ReferenceError`（`node --check` 抓不到）；派生变量必须 null 兜底 |
| 面板里一行「渲染失败：xxx is not defined」 | 组件里引用了当前作用域没有的变量（典型：把 `state.tasks` 写成 `tasks`）。`pageerror` 不会有记录，只能靠截图或 `innerText` 里找「渲染失败」 |
| 改了没生效 | 先跑 `npm run sync:profile` 看 profile 里的版本对不对（本地加载的是 profile 里的**拷贝**，不是仓库）；再查是否改了 `client.src.js` 却没跑 `make-legacy`；`cmp` 确认产物；浏览器强刷 |
| 部署说成功、目标机还是旧界面 | `tools/deploy.mjs` 输出里的 `restart=` 和 `version=`：`restart=NOT-APPLIED` = 文件传上去了但服务没重启（key 模式下 sudo 要密码就是这样，脚本退出码 4）；`version=` 对不上说明元数据没传（0.9.60 之前的脚本不传 `package.json`） |
| 主按钮只剩文字 | 是否又用了 `hsl(var(--primary))`；改实色 |
| 弹窗/抽屉看不见 | Portal 容器是否缺 `data-dsh-studio` 属性 |
| 拖拽没反应 | 卡片是否有 `draggable`、列上是否有 `onDragOver/onDrop`、路由是否是 `/task/update` |
| 服务每 5 分钟自杀一次 | 定时器里给**导入绑定**赋值（`larkProbeCache = …`）：ESM 导入只读，抛 `Assignment to constant variable`；改成调 `invalidateLarkProbe()` 这类 setter |
| 点击页面卡顿 | DevTools Performance 找长任务；`keyboardPatch` 之类全量扫描是历史元凶 |
| 派单没留言 | 会话日志里找 `turn/end reason.kind=error`；常见是模型无可用通道（503） |
| 保存成功但字段为空 | `publicConfig`/`mergeConfig`/`sanitize*` 白名单漏字段 |
| 测完失败路径改动没生效 | 用 `git checkout -- package.json` 还原测试用的假版本，会把**同一个文件里**刚加的其它改动一起还原。还原后 `grep` 一下你新加的那行还在不在 |
| 用脚本改文档后「什么都没变」 | 生成脚本文本里带了反引号，把模板字符串截断了：Node 抛 `ReferenceError: xxx is not defined` 但**编辑一句都没执行**。改完看 `git status`，别只看脚本退出码 |
