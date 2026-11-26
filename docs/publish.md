# 发布到 DSH 插件市场（dsh-m）

市场里能搜到、能一键装，需要三件事：**包发出去**、**条目被收录**、**版本对得上**。下面按顺序说，都是照着 `dsh-m` 的 `registry.json` 结构写的。

## 0. 先确认包本身是「可发布」的

`package.json` 里这几项是市场能不能认出来的关键（当前值已就绪）：

| 字段 | 现在 | 为什么 |
| --- | --- | --- |
| `name` / `version` | `dsh-studio` / 语义化版本 | 市场条目按这两项锁版本 |
| `private` | **已删除** | 留着就发不出去 |
| `keywords` | `dsh`, `dsh-plugin`, … | 市场/搜索用来分类 |
| `license` | `Apache-2.0` | 收录时会看 |
| `dsh` | `bundle.patch` + `client` + `compatibility` | 宿主靠它挂载面板、判断兼容 |
| `files` | 只带运行需要的东西 | 别把 `web/`、测试、探针打进去 |

发布前必跑：

```bash
npm run check          # 语法 + 契约 + 全量测试
cd web && pnpm build   # 产物必须和 client.js 逐字节一致
cd .. && cmp -s dist/client.js client.js && echo same
```

## 1. 发版（两条路，市场两种都吃）

**A. npm（推荐）** —— 市场条目写 `"source": "npm"`，安装时锁**最新精确版本**：

```bash
npm publish --access public      # 作用域包必须带 --access public 才公开
```

**B. GitHub** —— 市场条目写 `"source": "github"`，安装时锁 **commit SHA**，跟踪 tag 而不是 `main`：

```bash
git tag v0.2.0 && git push origin v0.2.0
```

> 跟踪 tag 是有意的：`main` 上的中间提交可能不稳定，市场只认你明确打出来的版本。

### 1.1 `--tag` 与 `next` 通道（和 OIDC 不是一回事）

- **OIDC（Trusted Publishing）只管「认证」**：它替代 `NPM_TOKEN` 让 CI 能 `npm publish`。它**不给**
  `dist-tag` / `unpublish` / `deprecate` 的权限 —— 这三件事天生只能在本机用登录态做。
- **`--tag` 是 npm 对预发布号的硬要求**：版本号里带 `-`（`0.9.19-next.0` 这种）却不给 `--tag`，
  npm 直接拒绝发布，因为它绝不允许预发布悄悄变成 `latest`。所以只要还发预发布，就**必须**给某个 tag，
  但不一定叫 `next`。
- **`next` 的语义是「最新预发布」**，不是「最新版本」。它发布后一直留在 registry 上，**正式版不会把它挪走**：
  0.2.2-rc.3 就是这么在 `next` 上挂了整整一代（此后 0.3 → 0.9 十几个正式版全走 `latest`），
  于是 `npm i @marsken/dsh-studio@next` 装到的是早于全部功能的构建。
- 规则：**`next` 要么不存在，要么不比 `latest` 旧。** `npm run verify:release` 断言这一条；
  `release.yml` 发预发布时会打 `::warning::` 提醒。正式版一发，同号 `-next.0` 立刻变旧 → 守卫变红 →
  这时必须二选一：`npm dist-tag rm @marsken/dsh-studio next`（不要预发布通道了）或
  `npm dist-tag add @marsken/dsh-studio@<新版> next`。
- **流水线每次发布后都会自己查一遍**：`release.yml` 在 publish 之后跑 `tools/dist-tag-lint.mjs`，
  只要 `next` 比这次发的版本旧，Actions 日志里就有一条 `::warning::` 并附上可直接复制的
  `npm dist-tag rm …` —— 它**不阻塞发版**（CI 没有 dist-tag 权限），本机的 `npm run verify:release`
  才是硬拦。想在本机先看一眼：`node tools/dist-tag-lint.mjs`（加 `--strict` 变成非零退出）。

### 1.2 删除 / 弃用单个版本（npm 的 72 小时规则）

npm 的策略很硬：**发布满 72 小时后，版本就删不掉了**，registry 上永久保留（别人的 lockfile 可能锁着它）。
在那之前可以删，但只该删「从来没人该装」的版本。

| 距发布 | 能做什么 | 命令 |
| --- | --- | --- |
| < 72 小时 | `unpublish`（单版本）+ `deprecate` | `npm unpublish @marsken/dsh-studio@0.2.2-rc.3 --force` |
| ≥ 72 小时 | **只能** `deprecate`（装的时候出警告，版本仍在） | `npm deprecate "@marsken/dsh-studio@<=0.5.1" "装完不加载，请升到 latest"` |

`unpublish` 还要过 npm 自己那关：包还有别的版本、没有其它包依赖它、下载量不高、你是 owner。
被拒就退回 `deprecate`，别去开支持单。

**删之前先摘 dist-tag**：`npm dist-tag ls @marsken/dsh-studio` —— 有 tag 指着这个版本时先
`npm dist-tag rm @marsken/dsh-studio <tag>`（0.2.2-rc.3 当年就是被 `next` 指着）。

**代价**：删掉后，锁着该版本的 `package-lock.json` 再装会 404/ETARGET，必须重装 `@latest`。
所以**正式版本一个都别删**，删的只有两类：调 CI 试发的预发布、确认装完就坏的版本。

2026-11-20 的清理清单（维护者本机执行；CI 做不了）：

```bash
npm dist-tag ls @marsken/dsh-studio            # 先确认没有 tag 指着待删版本
npm unpublish @marsken/dsh-studio@0.2.2-rc.1 --force
npm unpublish @marsken/dsh-studio@0.2.2-rc.2 --force
npm unpublish @marsken/dsh-studio@0.2.2-rc.3 --force
npm deprecate @marsken/dsh-studio@0.9.0 "侧栏不注册（注册名写成了短名），请装 @marsken/dsh-studio@latest"
npm deprecate @marsken/dsh-studio@0.9.1 "recordAudit 裸引用，写工具会报错，请装 @marsken/dsh-studio@latest"
npm deprecate "@marsken/dsh-studio@<=0.5.1" "cordis.patch.yml 写的是裸名 dsh-studio，装完不加载，请装 @marsken/dsh-studio@latest"
```

**2026-11-20 执行结果**（`npm view @marsken/dsh-studio versions` + registry packument 逐条核对）：

| 处理 | 版本 | 状态 |
| --- | --- | --- |
| `unpublish` | `0.2.2-rc.1` / `rc.2` / `rc.3` | ✅ 已从 registry 消失（版本数 103 → 100） |
| `deprecate` | `0.9.0` / `0.9.1` | ✅ 文案：侧栏不注册 / `recordAudit` 裸引用 → 升 `latest` |
| `deprecate` | `<=0.5.1` 共 **71 个**（`0.0.0-stage`、`0.1.0`–`0.1.47`、`0.2.0`–`0.2.8`、`0.3.0`–`0.3.9`、`0.4.0`、`0.5.0`、`0.5.1`） | ✅ 文案：`cordis.patch.yml` 裸名 → 升 `latest` |
| 待定 | `0.9.19-next.0`（占着 `next`，72h 窗口到 2026-11-22T19:33Z） | ⬜ 不要预发布通道：`npm dist-tag rm @marsken/dsh-studio next` + `npm unpublish @marsken/dsh-studio@0.9.19-next.0` |
| 不动 | `0.5.2` – `0.9.18` | 能正常加载的版本；`0.9.12` 及更早只有桌面版抽屉被窗口按钮盖住这种小毛病（0.9.13 起修复），不值得弃用 |

> 判据只有一条：**这个版本装上去会不会坏**。会坏（加载失败 / 侧栏没入口 / 工具报错）→ 删或弃用；
> 只是旧 → 不动，弃用太多会把「别装这个」的信号稀释成噪音。

## 2. 收录：投 awesome-dsh-plugin，不是给 dsh-m 提 PR

dsh-m 的市场数据来自两处，**入口完全不同**：

| 分区 | 数据来源 | 我们怎么进 |
| --- | --- | --- |
| 社区目录（6,000+ 条） | [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，经 npm 包 `dsh-plugin-catalog` 分发 | **投稿一个 YAML 文件**——第三方插件的既定入口 |
| 精选清单（`registry.json`，七个策展桶） | `iasiv5/dsh-m` 仓库，维护者手工策展 | **不收外部投稿**：给 registry 加第三方条目的 PR 会被礼貌关闭 |

所以「发布到 dsh-m」的实际动作是：**向 awesome-dsh-plugin 提一个 PR**。合并后 dsh-m 的社区目录在下一次同步即可搜到，社区分区、dsh-market 等下游读者都会自动跟进——收录一次，处处生效。

投稿文件已备好：`docs/awesome-dsh-plugin/marsken88__dsh-studio.yml`，
目标路径 `data/plugins/marsken88__dsh-studio.yml`（文件名必须 `<owner>__<repo>.yml`，一个文件就是全部投稿，PR 里只加这一个文件）。

条目形状（字段顺序无所谓，但只有这几个是认的）：

```yaml
url: https://github.com/marsken88/dsh-studio      # 必须与仓库地址完全一致
name: marsken88/dsh-studio                        # 列表里的链接文字
category: workflow                                # 见下方分类表
description:
  en: One-line factual description ending with a period.   # 必填
  zh: 一句话中文描述，以句号结尾。                            # 可选，缺了维护者会补
icon: https://raw.githubusercontent.com/…/icon-180.png      # 可选，GitHub 托管的位图
```

要点：

- **`dsh.bundle` 必须有**：`package.json` 里声明 `dsh.bundle.patch` 并在仓库根放 `cordis.patch.yml`——只声明 `dsh.client` 是 CI 最常见的打回原因（无法 `dsh plugin add`）；
- **仓库要带 `dsh-plugin` topic**（仓库首页 About 齿轮 → Topics），CI 会查；
- **仓库年龄 ≥ 1 天**（CI 自动查，刚建的仓库等一下再投）；
- **`icon` 只收 GitHub 托管的位图**（png/jpg/jpeg/webp，96px 见方最清楚）；SVG 与第三方图床会被拒——我们用 `assets/icon-180.png`（180×180 PNG，raw 直链已验证可访问）；
- **描述必须属实、不带营销词**：条目里的每一句都会被对着代码核，数字与 API 名字更要能对上；
- **`category` 取最贴的一个**：可选 `agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`；选得不够准维护者会直接改，不会打回；
- **截图**：在自己仓库根放 `screenshots.json`（1–8 张、相对路径、不能跳出目录），合并后市场详情页按这个顺序展示；
- **npm 不是门票**：发不发 npm 都能收录；发了才有下载量数字，且包的 `repository` 必须指回本仓库（`@marsken/dsh-studio` 已指回）；
- 条目里**不要**手写 `npm:` 字段——市场从 registry 自动采集，手写会被校验拒绝。

每个 PR 最多 3 条；我们只投 1 条。评审周期以天计（维护者要读代码核对描述），`held: author` 标签表示「等你改」，改完推同一分支并留一条评论即可。

### 注意：收录合并 ≠ 市场显示最新

发版后有三环，**每一环都有延迟，别拿市场页面判断发布是否成功**：

```
npm publish（几分钟生效，以 registry 为准）
   ↓  awesome-dsh-plugin 的 PR 合并（以天计，维护者要读代码核对描述）
   ↓  dsh-plugin-catalog 重建（按 npm latest 采集，下一次重建才带上新版本）
市场里显示的那个版本号
```

实测（2026-11-18）：PR 已于 11-17 合并，但当天拉下来的 `dsh-plugin-catalog`
里我们条目的 `versions` 只有 `0.2.1` —— 而 npm 上已经是 `0.2.5`。目录重建之前，
市场详情页永远显示旧版本，本机 dsh-m 搜索也会因为索引缓存（`状态 stale`）搜不到。

**判断发布成功，只看这两处**：

- `npm view @marsken/dsh-studio version`（或直接读 registry packument）
- `npm run verify:release` 输出「发版一致」

市场版本只是下游展示，滞后是正常的，不需要为此重发或改仓库。

**投稿进度**：**已收录。** [awesome-dsh-plugin#16102](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16102) 于 2026-11-17T17:00Z 合并，只加了 `data/plugins/marsken88__dsh-studio.yml` 一个文件；生成的 README 里有我们那一行，dsh-m 社区目录搜得到（2026-11-25 实测 `dshm_search` 显示 `dsh-studio · 社区 · v0.15.0`）。

### 收录之后发生的事：条目被维护者加了「路由披露」

合并 **24 分钟后**，维护者 `fkysly` 一个 **88 个文件**的批量提交（`Disclose routes, fix names, pin renamed dates, drop fixed caveat`）把我们的 `description` 改成了带披露的版本：

> … quality is reported per expert. **Its HTTP routes have no DSH access check, so a web page open in your browser could call them.**

这不是针对我们：生成后的 README 里 **541 条**带同一句话，是全表普查。但对本站这条，它是**成立的**——2026-11-25 实测：

| 探测 | 结果 |
| --- | --- |
| `GET /studio-api/state` 不带任何凭据 | **200，88 KB 全量台账** |
| 同上，`Host` 伪造成 `evil.example.com` | **200**（没有 Host 校验） |
| 跨站 POST（`Origin` 与 `Host` 不同） | 403 `bad_origin`（CSRF 守卫有效） |
| POST 但 `Host` 与 `Origin` 同为攻击者域名（DNS rebinding 的形状） | **进到业务逻辑**——守卫一起失效 |

**摘掉这句话的路径（不是重投一次）：改代码 → 发版 → 只改自己那条 yml 的 PR。** 上游已有两次先例：

- [#18520](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18520) `dsh-syncthing-pair v1.0.1`：作者把路由接进 `ctx.connection.requestRejection`，PR 正文贴了 401/403/200 三条实测，合并；
- `bcd738dd` `nuclearmilk/dsh-hud`：修好之后维护者直接 `drop HTTP access check caveat`。

本站的实现见「未发布」的 `CHANGELOG` 与 `src/host/access.js` 的 `trustRejectionOutcome`：403（Host/Origin）谁都不豁免，401（没有已认证会话）只豁免公开自助提单面与 `/health`。对应 PR 的写法照 #18520：正文写清**改了什么、release 链接、commit 链接、401/200/403 三条实测**，并声明「只改自己那一条」。不要动别人的条目，一个 PR 最多 3 条。

> 判断「收录是否生效」只看三处：`npm view @marsken/dsh-studio version`、`npm run verify:release`、以及上游 `data/plugins/marsken88__dsh-studio.yml` 的内容。市场页面显示哪个版本只是下游展示，滞后是正常的。


## 3. 自查清单（收录前逐条过）

- [ ] `npm run check` 全绿；干净 clone 上能构建出**逐字节一致**的产物
- [ ] `docs/quickstart.md` 里的三条命令在新机器上跑得通
- [ ] `README.md` 第一节就是「怎么装、怎么开」，没有内部主机名/IP/密码
- [ ] 没有把密钥、内网地址、个人路径写进仓库（`git grep -nE '192\.168\.|/home/[a-z]+'`）
- [ ] `license` 与 `LICENSE` 文件一致
- [ ] 版本号更新，tag 已推
- [ ] **dist-tags 没有悬空通道**：`npm view @marsken/dsh-studio dist-tags` —— `next` 要么没有、要么不旧于 `latest`。发过预发布（`--tag next`）的，下一个正式版发完必须 `npm dist-tag rm @marsken/dsh-studio next`（CI 只有 publish 权限，做不了这一步）；`npm run verify:release` 会替你断言这条
- [ ] 在**真实 dsh** 上装一遍（`dsh plugin --profile web add <包名>`），面板能开、`pageerror` 为空
- [ ] **仓库已加 `dsh-plugin` topic**（不带这个，awesome-dsh-plugin 的 CI 会挡）
- [ ] `assets/icon-180.png` 是 GitHub 托管的位图（SVG 会被拒）
- [ ] 根目录 `screenshots.json` 里列的图片都存在（`node -e` 逐条 exists 检查一遍）
- [ ] 条目文件按 `<owner>__<repo>.yml` 命名，描述以句号结尾、没有营销词、`: ` 已加引号

## 4. 装回来验一遍

```bash
dsh plugin --profile web add @marsken/dsh-studio   # npm 源
dsh plugin --profile web add github:marsken88/dsh-studio#v0.2.0
```

装完重启 dsh，跑 `node tools/visual/smoke.mjs`（需要 token 与 Chrome）确认九项检查全过。

## 踩坑记录（2026-11-13 首次发布 @marsken/dsh-studio@0.1.0）

这一节是实发时真撞上的，下次照做能省一圈：

**1. 先查名字，别想当然。**

```bash
npm view dsh-studio version     # → 0.0.1，别人 8 月占的位
npm view @<你的用户名>/dsh-studio version   # → 404 说明可用
```

npm 不允许覆盖别人的包名，撞名只能改作用域包（`@user/name`）或换名。

**2. 账号开了 2FA 时，普通 token 发不出去。**

```
npm error 403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

两条路：①生成 **Granular Access Token** 并勾上 **Bypass two-factor authentication**（推荐，之后 CI/脚本都能用）；②本机 `npm publish` 手输 6 位验证码。

**3. 发布成功 ≠ 立刻可查。**

`npm publish` 打出 `+ @marsken/dsh-studio@0.1.0` 之后，registry 仍会 404 **约 10 分钟**（npm 提示 `being processed`）。别急着重发，先轮询：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/@marsken%2Fdsh-studio   # 等到 200
npm view @marsken/dsh-studio version                                                      # 再确认版本号
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' $(npm view @marsken/dsh-studio dist.tarball)
```

**4. 凭据用完即删、发完即换。**

token 只写进临时 npmrc（放在仓库外或 `tmp/` 且不提交），发完立刻 `rm`；发完去 npm 后台 revoke 重新生成——凡是贴进聊天/工单/日志的 token 都当作已泄露。

**5. 作用域包必须带 `--access public`**，否则默认私有，市场里别人装不了（表现为 anonymous 访问 404）。
## 发布记录

> 这里只保留早期发布记录（0.1.x）；0.2 之后的每个版本见 [`CHANGELOG.md`](../CHANGELOG.md) 与 GitHub Releases。

| 版本 | 时间 | 内容 |
| --- | --- | --- |
| `0.1.0` | 2026-11-13 | 首个公开版：看板 / 需求 / 用例回归 / 效能 / 设计评审四期 |
| `0.1.1` | 2026-11-13 | 补三张 README 截图（npm 页可看图）；默认值与文档去掉公司内网信息 |
| `0.1.47` | 2026-11-17 | GitLab 核对到提交级 + CI 单测比对；/state 走 ETag（上千张卡不再重传）；补价目一键跳转；飞书拉正文在真文档上验通 |
| `0.1.46` | 2026-11-17 | 修派单必崩的 activeSkills；协作纪律写进 AGENTS 并变成准出检查 |
| `0.1.45` | 2026-11-16 | 交付物截图灯箱 + 筛选后自动滚到有卡的列 |
| `0.1.44` | 2026-11-16 | 手标的「通过」没有执行记录，交付时点名 |
| `0.1.43` | 2026-11-16 | 用例没跑/被跳过要在交付时点名；空用例不再静默成功 |
| `0.1.42` | 2026-11-16 | override 结构化记录，需求准出可见 |
| `0.1.41` | 2026-11-16 | 零证据不许交付（一条跑过的用例都没有） |
| `0.1.40` | 2026-11-16 | 功能点没有验收标准时提示（第三种拆卡体检） |
| `0.1.39` | 2026-11-16 | 反向拆卡体检（说没后端却要建表） |
| `0.1.38` | 2026-11-16 | 需求签字的准出门禁生效（可 override），修自挡死锁 |
| `0.1.37` | 2026-11-16 | 派单收尾采集宿主 tokenMeasurement（引擎真实 token） |
| `0.1.36` | 2026-11-16 | 用引擎真实窗口（1M）算占用率，替换 180k 猜测阈值 |
| `0.1.35` | 2026-11-16 | 上下文曲线标出压缩点（掉 30% 以上） |
| `0.1.34` | 2026-11-16 | 上下文面板改成看板式（指标块 / 峰值条 / 堆叠构成） |
| `0.1.33` | 2026-11-16 | 工具结果占上下文 ≥60% 时告警 |
| `0.1.32` | 2026-11-16 | 每轮上下文增长曲线（看有没有压缩） |
| `0.1.31` | 2026-11-16 | 单次会话的上下文构成（点开专家看占比） |
| `0.1.30` | 2026-11-16 | 效能页新增「上下文洞察（每个专家）」 |
| `0.1.29` | 2026-11-16 | 加 `npm run selfcheck`（三连跑看成功率） |
| `0.1.28` | 2026-11-16 | README 按读者重组：登录→docs/auth.md、界面→docs/ui.md |
| `0.1.27` | 2026-11-16 | README 补许可证一节 |
| `0.1.26` | 2026-11-16 | README 徽标补齐、架构图、流水账移到 docs/history.md |
| `0.1.25` | 2026-11-15 | 团级经验按相似度聚类，措辞变化不再漏 |
| `0.1.24` | 2026-11-15 | 反复出现的团级经验变成派单约束 |
| `0.1.23` | 2026-11-15 | 卡片镜像到飞书多维表格（手动触发，失败不谎报） |
| `0.1.22` | 2026-11-15 | 缺陷严重级按用例优先级（回归升级）+ 角色模板编辑界面 |
| `0.1.21` | 2026-11-15 | 需求基线可回滚（版本 +1、签字作废、留痕） |
| `0.1.20` | 2026-11-15 | 拆卡时提示「有后端但功能点没覆盖后端」 |
| `0.1.19` | 2026-11-15 | 需求澄清三问 + 拆卡门禁；修补答保存不上的白名单漏字段 |
| `0.1.17` | 2026-11-15 | 截图补到 10 张，且有脚本可重跑 |
| `0.1.16` | 2026-11-15 | quickstart 命令修正 + GitLab 打桩验证配方 |
| `0.1.15` | 2026-11-15 | 清掉三处过期的「已知限制」 |
| `0.1.14` | 2026-11-15 | 修正成本口径的过期文案 |
| `0.1.13` | 2026-11-15 | 价目表编辑器 + 未配价目模型清单 |
| `0.1.12` | 2026-11-15 | 真实 token 成本（读会话日志 + 价目表计价） |
| `0.1.11` | 2026-11-15 | 需求变更影响面（接口 + 面板）、可跑用例口径修正、成本口径文档 |
| `0.1.10` | 2026-11-15 | shell/db 用例可跑、GitLab 核对结果常驻显示、事件带 truncated、角色归并 |
| `0.1.9` | 2026-11-14 | 准出门禁提示「代码事实核对不通过」（只提醒，不拦） |
| `0.1.8` | 2026-11-14 | 卡进「待评审」时自动核对代码事实，对不上就写进 history 并记 gate/blocked |
| `0.1.7` | 2026-11-14 | webhook 投递结果进「集成健康」（地址写错了看得见） |
| `0.1.6` | 2026-11-14 | 回归跑完也发事件（regression/finished）；数据库用例可指定断言的列 |
| `0.1.5` | 2026-11-14 | agent/failed 事件、控制面板（执行开关 / 上限 / webhook 按事件订阅）、抽屉里加数据库用例入口 |
| `0.1.4` | 2026-11-14 | SQLite 用例、出站 webhook、可配置上限、执行器注册表 |
| `0.1.3` | 2026-11-13 | shell 用例（命令 + 退出码/输出断言，默认关闭） |
| `0.1.2` | 2026-11-13 | 修 5 个缺陷：卡片挂不上 MR、换列清空负责人、三处静默截断、还原度无历史、规范体检不定位元素 |

两条硬规矩，每次发版都过一遍：

1. `npm run check` + `pnpm build` + `cmp -s dist/client.js client.js`（产物必须逐字节一致）；
## 发完之后：GitHub Release 与 GitHub Packages

- **GitHub Release 是自动的**：`release.yml` 在 npm 发布成功后会调 `gh release create`，
  正文取 `CHANGELOG.md` 里这一版那一段（`tools/changelog-section.mjs`）。
  所以 Releases 页能不能看到版本，取决于两件事：tag 推上去了、CHANGELOG 写了这一版。
- **历史 tag 要补一次**：仓库有 71 个 tag，但 release 之前一个都没建过。补建走手动 workflow：
  Actions → **backfill-releases** → Run workflow（`limit` 填 `15` 补最近 15 个，填 `all` 补全部；
  `dry_run` 先看一眼要建哪些）。幂等的：已经有 release 的 tag 会跳过。
- **GitHub Packages 是镜像，不是主渠道**：它的 npm 源要求包 scope **等于仓库 owner**，
  所以镜像只能叫 `@marsken88/dsh-studio`（主包仍然是 npm 上的 `@marsken/dsh-studio`）。
  两个名字不是打错了：npm 账号是 `marsken`、GitHub 账号是 `marsken88`，同一个人的两个平台身份；
  npm 的 scope 与 GitHub 用户无关，而 GitHub Packages 只认仓库 owner。
  `publish-github-packages.yml` 负责这件事：**把 package.json 的 name 和 `cordis.patch.yml`
  里的 name 一起改**（只改一处 = 装了不加载，0.5.1 那个 issue 就是这条线崩的），
  然后 `npm publish --registry=https://npm.pkg.github.com --access public`，最后用
  `npm view` 回查一遍才算成功。`release.yml` 的 `mirror` job 在 npm 发完后自动调它。
  已发布过的同版本会跳过，所以重跑是安全的。
  **README 里的安装命令只教 npm 那条**：镜像给内网/CI 只能访问 GitHub 的环境用。

2. 发完**在临时 profile 里装一遍**（`dsh plugin --profile <tmp> install @marsken/dsh-studio@<版本>`）并跑 `dsh --profile <tmp> --dump-config | grep -A2 dsh-studio`（**顶层 `dsh` 命令**；写成 `dsh plugin ... --dump-config` 会透传给 pnpm 报 Unknown option），确认宿主真认到了，然后把 profile 删掉。
   **这一步是硬门槛，不是可选项**：0.5.1 及以前 `cordis.patch.yml` 里写的是裸名 `dsh-studio`，
   从 npm 装完 `plugin.not-loaded` + `ERR_MODULE_NOT_FOUND`，而所有本地探针都打的是手工部署的那份，
3. **发版一致性用命令查，不靠记性**：`npm run verify:release`（= `node tools/verify-release.mjs`）比对五处——
   package.json 版本、本地 tag、tag 里的 package.json、origin/main 与 origin 上的 tag、npm registry 的版本与 latest。
   全绿输出「发版一致」，有不一致退出码 1。
   **刚 publish 完那几分钟 registry 还看不到新版本**，这时用 `npm run verify:release -- --wait 180` 让它自己轮询等待，别把「还没同步」当成「没发」。
   这条是因为 0.1.15/0.1.16 真的发到 npm 了、git 却没推上去：`git tag -f vX.Y.Z && git push ... | tail -1` 会把 push 的失败吞掉。
   npm latest 滞后（刚发几分钟）只算 warn，不算失败。
4. 部署脚本退出码 0 **不等于服务活着**——它打印的 `state=` 要自己看一眼（探的是 `/studio-api/health`），再单独 `curl -o /dev/null -w '%{http_code}' <host>/studio-api/health` 确认 200（2026-11-13 有过一次 `state=404` 被当成成功，线上挂了十分钟）。**别用 `/studio-api/state` 探活**：那份台账要求已登录的浏览器会话，裸 curl 会拿到 401。
