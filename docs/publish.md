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

## 2. 收录条目

市场读的是条目清单，一个条目长这样（`registry.json` 里的真实结构）：

```json
{
  "id": "dsh-studio",
  "name": "DSH Studio",
  "description": "角色化多智能体工作台：产品/架构/研发/测试 + 看板 + 用例回归",
  "category": "essentials",
  "tags": ["多智能体", "看板", "研发流程"],
  "verified": ["0.2.2-rc.1"],
  "source": "npm",
  "npm": "@marsken/dsh-studio",
  "github": "marsken88/dsh-studio",
  "icon": "https://cdn.jsdelivr.net/npm/@marsken/dsh-studio@0/icon.svg",
  "homepage": "https://github.com/marsken88/dsh-studio"
}
```

要点：

- **`verified`** 是「在哪些宿主版本上真跑过」。别乱填——这块就是用户判断能不能装的依据；
- **`icon`** 走 jsDelivr 直链（`@0` 表示取最新大版本），所以图标要一起发进包里；
- **社区目录 vs 精选**：社区目录 6,000+ 条，随上游目录增长；精选（装机必备 / 崔添翼精选 / 自研 / 腾讯轻量云 / 观察区）是人工策展的。想让自己的插件进精选，需要向 `dsh-m` 仓库提条目；
- **`decoupled: true`** 表示「版本无关」，升级宿主不用跟着改，收录时可以争取。

## 3. 自查清单（收录前逐条过）

- [ ] `npm run check` 全绿；干净 clone 上能构建出**逐字节一致**的产物
- [ ] `docs/quickstart.md` 里的三条命令在新机器上跑得通
- [ ] `README.md` 第一节就是「怎么装、怎么开」，没有内部主机名/IP/密码
- [ ] 没有把密钥、内网地址、个人路径写进仓库（`git grep -nE '192\.168\.|/home/[a-z]+'`）
- [ ] `license` 与 `LICENSE` 文件一致
- [ ] 版本号更新，tag 已推
- [ ] 在**真实 dsh** 上装一遍（`dsh plugin --profile web add <包名>`），面板能开、`pageerror` 为空

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
