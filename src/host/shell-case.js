// shell 用例的数据形状。纯函数，放在这里是为了不把 domain.js 撑过 2000 行的闸门。

/** shell 用例：跑一条命令，看退出码与输出。默认**关**，要在设置里显式打开（见 config.testing.allowShell）。 */
export function sanitizeCaseShell(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const command = String(raw.command ?? '').trim().slice(0, 2000)
  if (command === '') return null
  return {
    command,
    cwd: String(raw.cwd ?? '').trim().slice(0, 300),
    timeoutMs: Math.max(1000, Math.min(120000, Number(raw.timeoutMs) || 30000)),
    expectExit: Number.isInteger(Number(raw.expectExit)) ? Number(raw.expectExit) : 0,
    expectContains: String(raw.expectContains ?? '').slice(0, 500),
    expectNotContains: String(raw.expectNotContains ?? '').slice(0, 500),
  }
}
