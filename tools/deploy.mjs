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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
const NO_RESTART = args.includes('--no-restart')
/** 传进安装脚本：auto = 尝试 sudo / 直连重启；skip = 只传文件。 */
const RESTART_MODE = NO_RESTART ? 'skip' : 'auto'

if (HOST === '' || USER === '') {
  console.error('缺少 DSH_DEPLOY_HOST / DSH_DEPLOY_USER')
  process.exit(2)
}

/** 宿主元数据：以前不在清单里，部署完目标机的 package.json 还停在老版本（真机 0.1.0 vs 0.9.59）。 */
const META = ['package.json', 'cordis.patch.yml', 'icon.svg', 'README.md']

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
  ...META.filter(name => existsSync(join(root, name))).map(name => ({ local: join(root, name), remote: name })),
  ...readdirSync(join(root, 'locale')).filter(name => name.endsWith('.json')).map(name => ({
    local: join(root, 'locale', name),
    remote: 'locale/' + name,
  })),
]

const INSTALL = `#!/bin/bash
set -u
DEST=${REMOTE_DIR}
STAMP=$(date +%Y%m%d-%H%M%S)
BEFORE=$(systemctl show dsh-web -p ExecMainStartTimestamp --value 2>/dev/null || echo unknown)
cp "$DEST/index.js" "${TMP}/index.js.$STAMP.bak" 2>/dev/null || true
cp "$DEST/client.js" "${TMP}/client.js.$STAMP.bak" 2>/dev/null || true
cp "$DEST/package.json" "${TMP}/package.json.$STAMP.bak" 2>/dev/null || true
cp "${TMP}/index.js" "$DEST/index.js"
cp "${TMP}/client.js" "$DEST/client.js"
if [ -d "${TMP}/src" ]; then mkdir -p "$DEST/src"; cp -r "${TMP}/src/." "$DEST/src/"; fi
for f in package.json cordis.patch.yml icon.svg README.md; do [ -f "${TMP}/$f" ] && cp "${TMP}/$f" "$DEST/$f"; done
if [ -d "${TMP}/locale" ]; then mkdir -p "$DEST/locale"; cp -r "${TMP}/locale/." "$DEST/locale/"; fi
cd "$DEST" && node --check index.js || { echo "SYNTAX_FAIL"; exit 1; }
echo "version=$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
RESTARTED=
if [ "${RESTART_MODE}" = "auto" ]; then
  echo '${PASSWORD}' | sudo -S systemctl restart dsh-web >/dev/null 2>&1 && RESTARTED=sudo
  if [ -z "$RESTARTED" ]; then sudo -n systemctl restart dsh-web >/dev/null 2>&1 && RESTARTED=sudo-nopass; fi
  if [ -z "$RESTARTED" ]; then systemctl restart dsh-web >/dev/null 2>&1 && RESTARTED=direct; fi
fi
AFTER=$(systemctl show dsh-web -p ExecMainStartTimestamp --value 2>/dev/null || echo unknown)
if [ "$BEFORE" = "$AFTER" ]; then echo "restart=NOT-APPLIED"; else [ -z "$RESTARTED" ] && RESTARTED=applied; echo "restart=$RESTARTED"; fi
for i in $(seq 1 25); do if ss -ltn 2>/dev/null | grep -q ':18080'; then break; fi; sleep 1; done
echo "active=$(systemctl is-active dsh-web)"
echo "files=$(find "$DEST/src/host" -name '*.js' | wc -l)"
STATE=000
# 探 /health 而不是 /studio-api/state：/studio-api 现在过宿主的信任栅栏
# （没有已认证的浏览器会话就 401），拿它当探活只会把「服务起来了」误判成 401。
# 先打 127.0.0.1（回环 Host 永远在栅栏的可信名单里），连不上再试部署地址。
for i in $(seq 1 20); do
  STATE=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/studio-api/health 2>/dev/null)
  [ "\${STATE}" = "200" ] || STATE=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://${HOST}:18080/studio-api/health 2>/dev/null)
  [ "\${STATE}" = "200" ] && break
  sleep 2
done
echo "state=\${STATE}"
`

if (DRY) {
  console.log(JSON.stringify({ host: HOST, user: USER, port: PORT, remoteDir: REMOTE_DIR, files, mode: PASSWORD !== '' ? 'ssh2(password)' : 'ssh/scp(key)' }, null, 1))
  process.exit(0)
}

/* 看门狗：10 分钟还没结束就强制退出并说明"上传可能已完成"。
   用 unref：它不该成为让进程活着的理由，但真挂住时必须能兜住。 */
const WATCHDOG = setTimeout(() => {
  console.error('deploy: 10 分钟没结束，强制退出。上传很可能已经完成 —— 去目标机核对 active= / 文件时间，别只看本脚本输出。')
  process.exit(3)
}, 10 * 60 * 1000)
WATCHDOG.unref()

/**
 * 只看 active 是不够的：文件传上去了但进程没重启时，active 照样是 active，
 * 界面上跑的还是旧代码。重启没生效必须说出来并非零退出，让人去处理。
 */
const verify = out => {
  console.log(out.trim())
  if (!/active=active/.test(out)) {
    console.error('部署后服务不是 active，先看 journalctl -u dsh-web')
    process.exit(1)
  }
  if (/restart=NOT-APPLIED/.test(out)) {
    if (NO_RESTART) {
      console.log('（--no-restart：按你的要求没有重启；新文件已落盘，跑 sudo systemctl restart dsh-web 生效）')
      return
    }
    console.error('部署完成但服务没有重启：新文件已经在目标机上，进程还在跑旧代码。')
    console.error('请执行：ssh <user>@<host> "sudo systemctl restart dsh-web"（或用密码模式重跑本脚本）')
    process.exit(4)
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
      console.log(`连接就绪：${USER}@${HOST}:${PORT}`)
      const sftp = await new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))))
      const run = cmd => new Promise((res, rej) => conn.exec(cmd, (e, stream) => {
        if (e) { rej(e); return }
        let out = ''
        stream.on('data', d => { out += d.toString() })
        stream.stderr.on('data', d => { out += d.toString() })
        stream.on('close', () => res(out))
      }))
      await run(`mkdir -p ${TMP}/src/host/routes ${TMP}/locale`)
      console.log(`开始上传 ${files.length} 个文件`)
      let uploaded = 0
      for (const file of files) {
        const target = file.remote.startsWith('src/') ? `${TMP}/${file.remote}` : `${TMP}/${file.remote}`
        await new Promise((res, rej) => sftp.fastPut(file.local, target, e => (e ? rej(e) : res())))
        uploaded += 1
        if (uploaded % 10 === 0) console.log(`  已上传 ${uploaded}/${files.length}`)
      }
      console.log(`上传完成，执行安装脚本（重启 dsh-web）`)
      const script = Buffer.from(INSTALL).toString('base64')
      await run(`printf %s '${script}' | base64 -d > ${TMP}/deploy-studio.sh`)
      console.log('安装脚本执行中…')
      verify(await run(`bash ${TMP}/deploy-studio.sh`))
      sftp.end()
      conn.end()
      /* ssh2 偶尔不释放定时器/套接字，脚本"做完了却不退出"，在 CI 或被脚本串起来时会一直卡住。
         验证已经通过，给 stdout 200ms 冲干净后主动退出。 */
      setTimeout(() => process.exit(0), 200)
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
  console.log(`连接就绪：${USER}@${HOST}:${PORT}（key 模式）`)
  ssh(`mkdir -p ${TMP}/src/host/routes ${TMP}/locale`)
  console.log(`开始上传 ${files.length} 个文件`)
  for (const file of files) {
    const target = file.remote.startsWith('src/') ? `${TMP}/${file.remote}` : `${TMP}/${file.remote}`
    scp(file.local, `${USER}@${HOST}:${target}`)
  }
  ssh(`printf %s '${Buffer.from(INSTALL).toString('base64')}' | base64 -d > ${TMP}/deploy-studio.sh`)
  verify(ssh(`bash ${TMP}/deploy-studio.sh`))
}
