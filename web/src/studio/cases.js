/* Multi-step HTTP cases are written one per line: METHOD url | expect | extract. */

export const parseSteps = (text) => String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => {
      const [head, expectRaw, extractRaw] = line.split('|').map(part => part.trim())
      const space = head.indexOf(' ')
      const method = space > 0 ? head.slice(0, space).toUpperCase() : 'GET'
      const url = space > 0 ? head.slice(space + 1).trim() : head
      const step = { method, url }
      if (expectRaw !== undefined && /^\d{3}$/.test(expectRaw)) step.expectStatus = Number(expectRaw)
      if (extractRaw !== undefined && extractRaw !== '') {
        // 提取变量：写 data.token 就自动叫 token；写 token=data.token 可以自己命名。
        const eq = extractRaw.indexOf('=')
        const name = eq > 0
          ? extractRaw.slice(0, eq).trim()
          : (extractRaw.split('.').pop() ?? '').trim()
        const path = eq > 0 ? extractRaw.slice(eq + 1).trim() : extractRaw
        if (name !== '' && path !== '') step.extract = { [name]: path }
      }
      return step
    })
    .filter(step => step.url !== '')
    .slice(0, 20)
