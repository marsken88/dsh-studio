// shell 用例执行器：跑一条命令，比对退出码与输出。
// 默认关闭（config.testing.allowShell）——打开它等于把「在宿主机执行任意命令」的能力交给看板。
import { exec } from 'node:child_process'

/** shell 用例：跑一条命令，比对退出码与输出。默认关闭，见 config.testing.allowShell。 */
export async function runShellCase(item, config) {
  const started = Date.now()
  const shell = item.shell
  if (config?.testing?.allowShell !== true) {
    return { ok: false, status: 0, ms: 0, error: '这台机器没开 shell 用例：设置 → 测试执行 里打开「允许 shell 用例」', preview: '' }
  }
  const cwd = shell.cwd !== '' ? shell.cwd : String(config?.testing?.shellCwd ?? '')
  const timeout = shell.timeoutMs > 0 ? shell.timeoutMs : 30000
  let stdout = ''
  let stderr = ''
  let code = 0
  try {
    const out = await new Promise(finish => {
      exec(shell.command, { cwd: cwd === '' ? undefined : cwd, timeout, maxBuffer: 1024 * 1024 }, (error, outText, errText) => {
        finish({ error, out: String(outText ?? ''), err: String(errText ?? '') })
      })
    })
    stdout = out.out
    stderr = out.err
    code = out.error === null || out.error === undefined ? 0 : (Number(out.error.code) || 1)
  } catch (error) {
    stderr = String(error?.message ?? error)
    code = 1
  }
  const combined = stdout + stderr
  const problems = []
  if (code !== shell.expectExit) problems.push('退出码 ' + code + '（期望 ' + shell.expectExit + '）')
  if (shell.expectContains !== '' && !combined.includes(shell.expectContains)) problems.push('输出里没有「' + shell.expectContains + '」')
  if (shell.expectNotContains !== '' && combined.includes(shell.expectNotContains)) problems.push('输出里有不该出现的「' + shell.expectNotContains + '」')
  return {
    ok: problems.length === 0,
    status: code,
    ms: Date.now() - started,
    error: problems.join('；').slice(0, 300),
    preview: combined.trim().slice(-600),
  }
}
