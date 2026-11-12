// Scopes every generated selector to the Studio subtree.
//
// The bundle injects its CSS into the host document, so an unscoped Tailwind
// build would restyle anything on the page that happens to use `.flex`, `.grid`,
// `.border`… This plugin rewrites `X` into `[data-dsh-studio] X`, which keeps the
// utility names readable in the components while making the cascade local.
//
// Note: we assign `rule.selector` (raw string) rather than `rule.selectors`, because
// postcss' list setter escapes backslashes a second time — `.w-\[380px\]` would
// come out as `.w-\\[380px\\]` and silently never match.
const SCOPES = ['[data-dsh-studio]', '[data-dsh-studio-portal]']
const SKIP_AT_RULES = /^(keyframes|-webkit-keyframes|font-face|charset|import|namespace)/i

function scopeSelector(selector) {
  const trimmed = selector.trim()
  if (trimmed === '') return trimmed
  // Token blocks in index.css already pick their own scope.
  if (trimmed.includes('[data-dsh-studio')) return trimmed
  if (trimmed === ':root' || trimmed === 'html') return SCOPES.join(', ')
  if (trimmed.startsWith('body')) return SCOPES.map(scope => trimmed.replace(/^body/, scope)).join(', ')
  return SCOPES.map(scope => `${scope} ${trimmed}`).join(', ')
}

// Splits on top-level commas only: :is(a, b) / [a=","] stay intact.
function splitSelectors(selector) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

export default function scopeToStudio() {
  return {
    postcssPlugin: 'scope-to-studio',
    Once(root) {
      root.walkRules((rule) => {
        const parent = rule.parent
        if (parent && parent.type === 'atrule' && SKIP_AT_RULES.test(parent.name)) return
        const selector = rule.selector
        if (!selector || selector.startsWith('@')) return
        rule.selector = splitSelectors(selector).map(scopeSelector).join(', ')
      })
    },
  }
}

scopeToStudio.postcss = true
