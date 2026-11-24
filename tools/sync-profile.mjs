// 把仓库同步进本地 profile 的插件目录，然后告诉你是否需要重启。
//
// 为什么需要它：profile 里 `link:<repo>` 在 Windows 上**不一定**真的建成链接——
// 实测 desktop profile 里是一份拷贝（2026-11-20 发现版本停在 0.9.14，而仓库已经 0.9.24）。
// 于是「改了代码 → 重启 → 没生效」，白折腾一轮。这个脚本把同步显式化：
//
//   node tools/sync-profile.mjs                 # 同步到 desktop profile
//   node tools/sync-profile.mjs --dry-run       # 只看要拷什么
//   node tools/sync-profile.mjs --profile web   # 指定 profile
//
// 宿主代码（index.js / src）与 client.js 都换掉；重启 dsh 后才会加载。
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const profileIndex = argv.indexOf('--profile')
const profile = profileIndex >= 0 ? String(argv[profileIndex + 1] ?? '') : 'desktop'
if (profile === '') {
  console.error('用法：node tools/sync-profile.mjs [--profile desktop] [--dry-run]')
  process.exit(1)
}

/** 插件运行时需要的文件（package.json 的 files 字段同源）。 */
const ITEMS = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'locale', 'src']
const target = join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@marsken', 'dsh-studio')

const version = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')).version ?? '?' } catch { return '（缺）' }
}

if (!existsSync(target)) {
  console.error(`✖ 找不到 ${target}\n  profile「${profile}」里还没装这个插件：先按 README 的安装步骤装一次。`)
  process.exit(1)
}
const from = await version(join(root, 'package.json'))
const before = await version(join(target, 'package.json'))
console.log(`同步 ${profile}: ${target}`)
console.log(`  仓库 ${from} → profile ${before}`)
for (const item of ITEMS) {
  if (!existsSync(join(root, item))) {
    console.error(`✖ 仓库里缺 ${item}`)
    process.exit(1)
  }
}
if (dryRun) {
  console.log(`  （dry-run）会覆盖：${ITEMS.join(', ')}`)
  process.exit(0)
}

// 备份：出问题能一眼回滚，且不会只剩"我记得之前是什么样"。
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backup = join(homedir(), '.dsh', 'backups', `dsh-studio-${stamp}`)

/* profile 里的插件目录可能已经不是拷贝，而是**指向仓库的符号链接/目录联接**（2026-11-20 就变成这样了）。
   那种情况下 src 和 dest 是同一个路径，cp 会抛 ERR_FS_CP_EINVAL("src and dest cannot be the same")。
   这时不需要同步——重启就够了；直接说清楚，别让人对着一堆堆栈猜。 */
/* 从**工作树**里跑这条命令时，profile 很可能是指向主检出的目录联接：
   那种情况下 src/dest 不是同一个路径，linked 判据不成立，脚本就会把工作树的文件
   直接写进主检出的工作区（2026-11-24 真的踩过：主检出凭空多出一堆未提交改动）。
   这里用 git 的 top-level 认「目标是不是另一个检出」，是就拒绝。 */
const gitTop = dir => {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
const pathKey = dir => resolve(dir).replace(/\\/g, '/').toLowerCase()
const targetTop = gitTop(target)
const rootTop = gitTop(root)
if (targetTop !== '' && rootTop !== '' && pathKey(targetTop) !== pathKey(rootTop)) {
  console.error(`✖ profile 指向的是另一个 git 检出，拒绝同步：\n  目标 ${targetTop}\n  当前 ${rootTop}\n  从工作树同步会覆盖那个检出的工作区。请在目标检出里运行，或等分支合并后再同步。`)
  process.exit(1)
}

const linked = (() => {
  try {
    return realpathSync(target) === realpathSync(root)
  } catch {
    return false
  }
})()
if (linked) {
  console.log('  ✓ profile 里是**指向仓库的链接**，不需要同步：改完重启 dsh 即可生效。')
  process.exit(0)
}

await mkdir(backup, { recursive: true })
for (const item of ITEMS) {
  const source = join(target, item)
  if (!existsSync(source)) continue
  await cp(source, join(backup, item), { recursive: true })
}
console.log(`  备份 ${backup}`)

for (const item of ITEMS) {
  const source = join(root, item)
  const dest = join(target, item)
  // 目录整体替换：避免删掉的模块以旧文件的形式留在 profile 里（上次就是靠"猜"才发现版本不一致）。
  if ((await stat(source)).isDirectory()) {
    await rm(dest, { recursive: true, force: true })
    await cp(source, dest, { recursive: true })
  } else {
    await cp(source, dest)
  }
}

const after = await version(join(target, 'package.json'))
const same = await readFile(join(root, 'client.js')).then(a => readFile(join(target, 'client.js')).then(b => a.equals(b)))
console.log(`  ✓ 写入完成：${after}；client.js ${same ? '一致' : '不一致（请重跑）'}`)
if (after !== from || !same) process.exit(1)
console.log('  重启 dsh 后生效（宿主半边 index.js/src 只有重启才会重新加载）。')
