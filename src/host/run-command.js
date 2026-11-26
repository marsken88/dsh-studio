/* 跑一个外部命令：有超时、不抛异常；lark-cli 之类没有时返回 ok:false。
 *
 * 从 executor.js 抬出来：它被「代码事实核对 / 项目检查 / 用例执行 / 飞书」多处共用，
 * 而 executor 有 2000 行闸门（2026-11-26 因核对逻辑膨胀顶到 2018）。
 */
import { spawn } from 'node:child_process'

import { commandArgs } from './cmd-args.js'

/** 跑一个外部命令，有超时、不抛异常；lark-cli 之类没有时返回 ok:false。 */
export function runCommand(command, args, timeoutMs = 20000, options = {}) {
  return new Promise(resolvePromise => {
    let child
    // Windows 上 npm 装的 CLI（lark-cli）是 .cmd 壳，spawn 直接执行会 ENOENT，必须经 cmd.exe；
    // 而 cmd.exe 会把 & | < > ^ % 当语法字符，所以参数要逐个加引号（见 cmd-args.js，真机两次踩过）。
    const viaCmd = process.platform === 'win32' && command === 'lark-cli'
    try {
      const plan = viaCmd ? commandArgs(command, args) : { file: command, argv: args }
      // windowsVerbatimArguments：由我们自己给参数加引号（否则 Node 的转义会和 cmd 的语法打架，
      // 实测 `|` 仍然会被当管道 → 命令被截断）。非 cmd 路径保持默认。
      child = spawn(plan.file, plan.argv, { windowsHide: viaCmd, windowsVerbatimArguments: viaCmd, stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd })
    } catch (error) {
      resolvePromise({ ok: false, code: -1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      resolvePromise({ ok: false, code: -1, stdout, stderr: String(error?.message ?? error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code, stdout, stderr })
    })
  })
}
