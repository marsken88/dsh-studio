#!/usr/bin/env node
/**
 * 把本仓库部署到目标机并重启 dsh-web。
 *
 * 为什么要这个脚本：AGENTS 里老的 deploy2.py 只传 index.js + client.js，
 * 而宿主拆成 src/host/*.js 以后，漏传 src/ 会直接 502（ReferenceError: ... is not defined）。
 * 这里一次把 index.js、dist/client.js 和整个 src/host 传上去，先备份再覆盖，最后自检。
 *
 * 用法：
 *   DSH_DEPLOY_HOST=<host> DSH_DEPLOY_USER=<user> DSH_DEPLOY_PASSWORD=*** node tools/deploy.mjs
 *   DSH_DEPLOY_HOST=<host> DSH_DEPLOY_USER=<user> node tools/deploy.mjs --key ~/.ssh/id_ed25519
 *
 * 环境变量：DSH_DEPLOY_HOST / DSH_DEPLOY_USER / DSH_DEPLOY_PASSWORD / DSH_DEPLOY_PORT(默认 22)
 * 参数：--remote-dir <path>（默认 ~/dsh-studio）--tmp-dir（默认 /tmp）--dry-run
 *
 * 密码模式需要 ssh2（仓库故意不把它写进依赖，避免插件安装多背一个包）：
 *   pnpm add -D ssh2     # 或 npm i -D ssh2
 * 不装 ssh2 也行：给 --key 或先把本机公钥授权到目标机（ssh-copy-id），走系统 scp/ssh。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf('--' + name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const HOST = process.env.DSH_DEPLOY_HOST ?? ''
const USER = process.env.DSH_DEPLOY_USER ?? ''
const PASSWORD = process.env.DSH_DEPLOY_PASSWORD ?? ''
const PORT = Number(process.env.DSH_DEPLOY_PORT ?? 22)
const REMOTE_DIR = option('remote-dir', process.env.DSH_DEPLOY_DIR ?? '~/dsh-studio')
const TMP = option('tmp-dir', '/tmp')
const KEY = option('key', '')
const DRY = args.includes('--dry-run')

if (HOST === '' || USER === '') {
  console.error('缺少 DSH_DEPLOY_HOST / DSH_DEPLOY_USER')
  process.exit(2)
}

const root = process.cwd()
const walk = dir => readdirSync(dir).flatMap(name => {
  const full = join(dir, name)
  return statSync(full).isDirectory() ? walk(full) : (name.endsWith('.js') ? [full] : [])
})

/** 要传的文件：宿主入口、构建产物、以及整个 src/host（漏一个就 502）。 */
const files = [
  { local: join(root, 'index.js'), remote: 'index.js' },
  { local: join(root, 'dist/client.js'), remote: 'client.js' },
  ...walk(join(root, 'src/host')).map(full => ({
    local: full,
    remote: 'src/host/' + full.slice(join(root, 'src/host').length + 1).split('\\').join('/'),
  })),
]

const INSTALL = `#!/bin/bash
set -u
DEST=${REMOTE_DIR}
STAMP=$(date +%Y%m%d-%H%M%S)
cp "$DEST/index.js" "${TMP}/index.js.$STAMP.bak" 2>/dev/null || true
cp "$DEST/client.js" "${TMP}/client.js.$STAMP.bak" 2>/dev/null || true
cp "${TMP}/index.js" "$DEST/index.js"
cp "${TMP}/client.js" "$DEST/client.js"
if [ -d "${TMP}/src" ]; then mkdir -p "$DEST/src"; cp -r "${TMP}/src/." "$DEST/src/"; fi
cd "$DEST" && node --check index.js || { echo "SYNTAX_FAIL"; exit 1; }
echo '${PASSWORD}' | sudo -S systemctl restart dsh-web >/dev/null 2>&1 || systemctl restart dsh-web >/dev/null 2>&1 || true
for i in $(seq 1 25); do if ss -ltn 2>/dev/null | grep -q ':18080'; then break; fi; sleep 1; done
echo "active=$(systemctl is-active dsh-web)"
echo "files=$(find "$DEST/src/host" -name '*.js' | wc -l)"
echo "state=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:18080' http://127.0.0.1/studio-api/state 2>/dev/null || echo 0)"
`

if (DRY) {
  console.log(JSON.stringify({ host: HOST, user: USER, port: PORT, remoteDir: REMOTE_DIR, files, mode: PASSWORD !== '' ? 'ssh2(password)' : 'ssh/scp(key)' }, null, 1))
  process.exit(0)
}

const verify = out => {
  console.log(out.trim())
  if (!/active=active/.test(out)) {
    console.error('部署后服务不是 active，先看 journalctl -u dsh-web')
    process.exit(1)
  }
}

if (PASSWORD !== '') {
  let Client
  try {
    ({ Client } = createRequire(import.meta.url)('ssh2'))
  } catch {
    console.error('密码模式需要 ssh2：pnpm add -D ssh2（或改用 --key 走系统 scp/ssh）')
    process.exit(2)
  }
  const conn = new Client()
  conn.on('ready', async () => {
    try {
      const sftp = await new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))))
      const run = cmd => new Promise((res, rej) => conn.exec(cmd, (e, stream) => {
        if (e) { rej(e); return }
        let out = ''
        stream.on('data', d => { out += d.toString() })
        stream.stderr.on('data', d => { out += d.toString() })
        stream.on('close', () => res(out))
      }))
      await run(`mkdir -p ${TMP}/src/host/routes`)
      for (const file of files) {
        const target = file.remote.startsWith('src/') ? `${TMP}/${file.remote}` : `${TMP}/${file.remote}`
        await new Promise((res, rej) => sftp.fastPut(file.local, target, e => (e ? rej(e) : res())))
      }
      const script = Buffer.from(INSTALL).toString('base64')
      await run(`printf %s '${script}' | base64 -d > ${TMP}/deploy-studio.sh`)
      verify(await run(`bash ${TMP}/deploy-studio.sh`))
      sftp.end()
      conn.end()
    } catch (error) {
      console.error('部署失败：', error.message)
      conn.end()
      process.exit(1)
    }
  }).on('error', e => { console.error('连接失败：', e.message); process.exit(1) })
    .connect({ host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 20000 })
} else {
  const ssh = (...argv) => execFileSync('ssh', ['-p', String(PORT), ...(KEY === '' ? [] : ['-i', KEY.replace('~', homedir())]), `${USER}@${HOST}`, ...argv], { encoding: 'utf8' })
  const scp = (...argv) => execFileSync('scp', ['-P', String(PORT), ...(KEY === '' ? [] : ['-i', KEY.replace('~', homedir())]), ...argv], { encoding: 'utf8' })
  ssh(`mkdir -p ${TMP}/src/host/routes`)
  for (const file of files) {
    const target = file.remote.startsWith('src/') ? `${TMP}/${file.remote}` : `${TMP}/${file.remote}`
    scp(file.local, `${USER}@${HOST}:${target}`)
  }
  ssh(`printf %s '${Buffer.from(INSTALL).toString('base64')}' | base64 -d > ${TMP}/deploy-studio.sh`)
  verify(ssh(`bash ${TMP}/deploy-studio.sh`))
}
