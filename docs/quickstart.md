# 第一天上手（三条命令）

这份文档的每一行都**在一个全新 clone 上跑过**（2026-11-13 验证），不是凭印象写的。

## 前提

- Node **≥ 22**（线上跑 v24；`node:sqlite`、`node:test` 都要它）
- pnpm（只在构建前端时需要；`npm i -g pnpm` 或 `npx pnpm@10`）
- 要部署/冒烟还需要：目标机的 ssh 账号、一个系统 Chrome

```bash
git clone ssh://git@ssh.github.com:443/marsken88/dsh-studio.git
cd dsh-studio
npm test                      # 1) 77 条测试，不用先装依赖
```

只跑到这一步，你已经知道「代码是好的」——测试不需要任何依赖，因为它们只碰纯函数和一个临时 SQLite。

```bash
cd web && pnpm install --frozen-lockfile && pnpm build && cd ..   # 2) 重建前端
cmp -s dist/client.js client.js && echo same                     #    产物必须一致
```

`pnpm install` 会提示 `Ignored build scripts: esbuild` —— **正常**，vite 用的是预编译 esbuild，构建照样过。
`cmp` 打出 `same` 说明你构建的产物和仓库里那份**逐字节一致**（CI 的红线就是这个）。

```bash
DSH_DEPLOY_HOST=<host> DSH_DEPLOY_USER=<user> DSH_DEPLOY_PASSWORD=<pw> node tools/deploy.mjs   # 3) 部署
```

它会传 `index.js` + `dist/client.js` + **整个 `src/host`**，先备份旧文件，跑远端 `node --check`，重启 dsh-web，最后打印 `active= / files= / state=`；不是 `active` 就以非零退出。

## 然后：证明它真的活着

```bash
STUDIO_TOKEN=<面板 token> node tools/visual/smoke.mjs
```

九项检查：能打开 → 侧栏进得去 → 面板挂载 → 六个页签 → 看板有卡 → 用例库有行 → 套件渲染 → `pageerror` 必须为空。任何一项不过退出码非零。

token 从哪来：dsh web 启动时会把带 token 的地址打进 journal，

```bash
echo <pw> | sudo -S journalctl -u dsh-web -n 50 | grep -o 'token=[A-Za-z0-9_-]*' | tail -1
```

## 别做的事

- 别手改 `dist/client.js` / 根 `client.js`（下次构建就覆盖，CI 也会红）
- 别在目标机上直接改文件（下次部署即丢）
- 别跳过构建就提交前端改动（`git diff --exit-code` 会拦住你）

更细的规矩在 `AGENTS.md`；用户向的功能说明在 `README.md`。