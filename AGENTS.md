# dsh-studio · 开发指南

给接手这个仓库的人（和 AI）看的操作手册。原则只有一条：**改动必须能在真实浏览器与真实 dsh 上验证，验证不出来的改动不算完成。**

## 1. 仓库结构

| 路径 | 是什么 | 谁能改 |
| --- | --- | --- |
| `index.js` | 宿主半边：`apply(ctx)`、39 个 `studio_*` 工具、`/studio-api/*` 路由、SQLite 存储、派单引擎、门禁 | ✅ 直接改 |
| `client.src.js` | 浏览器半边的手写源码（通过 `window.__ModuleLoader__` 注册面板） | ✅ 直接改（前端逻辑） |
| `web/src/**` | shadcn/Radix 组件、样式、`legacy.js` 桥 | ✅ 直接改（样式与组件） |
| `web/dist/client.js` | `pnpm build` 的产物（单文件 IIFE） | ❌ 生成物 |
| `client.js`（包根） | 上面产物自动同步过来的副本，dsh 真正加载的那个 | ❌ 生成物 |
| `cordis.patch.yml` | bundle patch，把本包挂进 profile | ✅ |
| `locale/*.json` | 面板标题/描述等元数据 | ✅ |
| `README.md` | 用户向文档（安装、功能、排障） | ✅ |
| `docs/compatibility.md` | 我们对 dsh 宿主接口的依赖清单与升级 runbook | ✅ 改动宿主调用时必须同步 |

## 2. 三个前端文件的关系（最容易搞错的地方）

```
client.src.js              手写源码
      │  web/scripts/make-legacy.mjs  →  web/src/legacy.js
      ▼
web/src/**  ── vite build ──▶  web/dist/client.js  ── sync-client.mjs ──▶  根 client.js
```

- 改**前端逻辑** → `client.src.js`
- 改**样式/组件/主题** → `web/src/**`
- 改完一律在 `web/` 里构建：`pnpm build`（= `make-legacy` → `vite build` → `sync-client`）
- 构建后自检：`cmp -s web/dist/client.js client.js && echo same`，大小应约 700 KB（gzip ≈ 207 KB）

> 曾经漏跑 `make-legacy`，`client.src.js` 的改动根本没进 bundle，白改好几轮。构建脚本已经把它串进 `build`，不要手工跳过。

## 3. 构建与部署

```bash
# 1) 构建（Windows 上用随包 pnpm）
cd dsh-studio/web
node C:/Users/hp/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs run build

# 2) 上传：index.js + client.js → 目标机 /tmp/index.js、/tmp/client.js
#    本机用 paramiko 脚本（tmp/deploy2.py，不入库），或等价 scp

# 3) 远端安装并重启（脚本已存在于目标机 /tmp/deploy-all.sh）
bash /tmp/deploy-all.sh     # cp 两个文件到 /home/lyf/dsh-studio，restart dsh-web，打印 is-active
```

验收三件事：`systemctl is-active dsh-web` = `active`；浏览器打开 `http://<host>/` 侧栏出现「需求&任务工作空间」；`GET /studio-api/state` 返回 200 且 `revision` 递增。

## 4. 每次改动前后的硬性检查

1. `node --check index.js && node --check client.src.js`（语法；但**查不出**运行期 `ReferenceError`，见第 11 节）
2. 构建后 `cmp` 两个 client.js 一致
3. 服务端行为：写一个 `tmp/*.mjs`（或 `.py`）脚本直接打 `/studio-api/*`，**不要在 PowerShell 里内联复杂 `node -e`**
4. UI 行为：用 `tools/visual/*.mjs` 里的 headless 探针（puppeteer-core 在该目录下），必须
   - 先点侧栏文字进入面板，再等 `[data-dsh-studio]`
   - 切页签用 `elementHandle.click()`（Radix Tabs 不认 DOM `.click()`）
   - 断言 DOM + `pageerror` 为空，并截图留档
5. 涉及权限/门禁/发布的重改动，跑一遍既有 e2e 脚本并贴出数字

## 5. 禁止事项

- ❌ 手改 `web/dist/client.js` 或根 `client.js`（会被下次构建覆盖）
- ❌ 直接在目标机上改文件而不回写仓库（下次部署即丢）
- ❌ 用 `powershell -Command "node -e \"...\""` 这类多层引号跑逻辑；一律落成 `tmp/*.js|mjs|py`
- ❌ 用 `split("\r\n")` 编辑 README（本仓库是混合行尾）：用 `split(/\r?\n/)`，写回统一 `\r\n`
- ❌ 在 UI 线程里做「读样式 + 写属性」交替的批量循环（会触发强制同步布局，实测 685 ms 长任务）
- ❌ 删除用户数据前不备份：先 `cp ~/.dsh/dsh-studio.db /tmp/...`，再操作

## 6. 后端约定（`index.js`）

- **白名单三件套**：`publicConfig()`（对外可见字段）、`mergeConfig()`（可写入字段）、`sanitizeX()`（每个对象）。新增任何配置/字段，三处都要加，否则会出现「保存 200 但读回来是空」。
- `StudioStore.mutate(fn)` **返回整份 state**，不是 `fn` 的返回值；要拿某张卡用 `store.snapshot().tasks.find(...)`。
- 所有对外状态走 `publicState()`：`{ revision, config, tasks, requirements, releases, experts, … }`。
- 路由统一挂在 `/studio-api`（`ctx.webServer.register({ kind:'prefix' })`）；新增路由记得同时更新权限分级 `accessLevelFor` 与 `/auth/*` 例外。
- 迁移走 `config.schema` 版本号 + `#load()` 里的顺序迁移函数，禁止「就地猜测数据形状」。
- 长任务（派单、GitLab 同步、飞书推送）不得阻塞请求线程；失败要写进任务 `history` 或审计，不许静默。

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
- 提交前确保根 `client.js` 与 `web/dist/client.js` 一致（clone 下来即可安装靠的就是这一点）。
- 版本号在 `package.json`；发布标签 `vX.Y.Z`。

## 11. 常见故障速查

| 现象 | 先查这里 |
| --- | --- |
| 页面白屏 | 浏览器 console 的 `ReferenceError`（`node --check` 抓不到）；派生变量必须 null 兜底 |
| 改了没生效 | 是否改了 `client.src.js` 却没跑 `make-legacy`；`cmp` 确认产物；浏览器强刷 |
| 主按钮只剩文字 | 是否又用了 `hsl(var(--primary))`；改实色 |
| 弹窗/抽屉看不见 | Portal 容器是否缺 `data-dsh-studio` 属性 |
| 拖拽没反应 | 卡片是否有 `draggable`、列上是否有 `onDragOver/onDrop`、路由是否是 `/task/update` |
| 点击页面卡顿 | DevTools Performance 找长任务；`keyboardPatch` 之类全量扫描是历史元凶 |
| 派单没留言 | 会话日志里找 `turn/end reason.kind=error`；常见是模型无可用通道（503） |
| 保存成功但字段为空 | `publicConfig`/`mergeConfig`/`sanitize*` 白名单漏字段 |
