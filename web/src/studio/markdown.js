/* Markdown → React nodes for the Studio panel. Kept out of client.src.js so the
   renderer can be reasoned about (and tested) without the whole page. `h` is
   injected because this file has no React import of its own: client.src.js is
   the no-bundler artifact and borrows the host React instance. */

export function createMarkdown(h) {
    function inlineMd(text, prefix) {
      const nodes = []
      const pieces = String(text ?? '').split(/(`[^`]+`)/g)
      pieces.forEach((piece, pieceIndex) => {
        if (piece.length > 1 && piece.startsWith('`') && piece.endsWith('`')) {
          nodes.push(h('code', { key: `${prefix}c${pieceIndex}` }, piece.slice(1, -1)))
          return
        }
        const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g
        let cursor = 0
        let match
        while ((match = pattern.exec(piece)) !== null) {
          if (match.index > cursor) nodes.push(piece.slice(cursor, match.index))
          const k = `${prefix}i${pieceIndex}-${match.index}`
          if (match[1] !== undefined) nodes.push(h('a', { key: k, href: match[2], target: '_blank', rel: 'noreferrer' }, match[1]))
          else if (match[3] !== undefined || match[4] !== undefined) nodes.push(h('strong', { key: k }, match[3] ?? match[4]))
          else nodes.push(h('em', { key: k }, match[5] ?? match[6]))
          cursor = match.index + match[0].length
        }
        if (cursor < piece.length) nodes.push(piece.slice(cursor))
      })
      return nodes
    }

    function renderMarkdown(source) {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let index = 0
      const k = at => `md${at}`
      const isDivider = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
      const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
      while (index < lines.length) {
        const line = lines[index]
        const at = index
        if (/^\s*$/.test(line)) { index += 1; continue }
        if (/^\s*```([\w+#-]*)\s*$/.test(line)) {
          const body = []
          index += 1
          while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { body.push(lines[index]); index += 1 }
          index += 1
          blocks.push(h('pre', { key: k(at) }, h('code', null, body.join('\n'))))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = Math.min(6, heading[1].length + 2)
          blocks.push(h(`h${level}`, { key: k(at) }, inlineMd(heading[2], k(at))))
          index += 1
          continue
        }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: k(at) }))
          index += 1
          continue
        }
        if (/^\s*>/.test(line)) {
          const body = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            body.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          blocks.push(h('blockquote', { key: k(at) }, renderMarkdown(body.join('\n'))))
          continue
        }
        if (line.includes('|') && index + 1 < lines.length && isDivider(lines[index + 1])) {
          const head = cells(line)
          index += 2
          const rows = []
          while (index < lines.length && lines[index].includes('|') && !/^\s*$/.test(lines[index])) {
            rows.push(cells(lines[index]))
            index += 1
          }
          blocks.push(h('table', { key: k(at) },
            h('thead', null, h('tr', null, head.map((cell, i2) => h('th', { key: i2 }, inlineMd(cell, `${k(at)}h${i2}`))))),
            h('tbody', null, rows.map((row, r) => h('tr', { key: r }, head.map((_, c2) => h('td', { key: c2 }, inlineMd(row[c2] ?? '', `${k(at)}r${r}c${c2}`)))))),
          ))
          continue
        }
        const bullet = /^\s*[-*+]\s+(.*)$/
        if (bullet.test(line)) {
          const items = []
          while (index < lines.length && bullet.test(lines[index])) {
            items.push(h('li', { key: index }, inlineMd(bullet.exec(lines[index])[1], `${k(at)}l${index}`)))
            index += 1
          }
          blocks.push(h('ul', { key: k(at) }, items))
          continue
        }
        const numbered = /^\s*\d+[.)]\s+(.*)$/
        if (numbered.test(line)) {
          const items = []
          while (index < lines.length && numbered.test(lines[index])) {
            items.push(h('li', { key: index }, inlineMd(numbered.exec(lines[index])[1], `${k(at)}n${index}`)))
            index += 1
          }
          blocks.push(h('ol', { key: k(at) }, items))
          continue
        }
        const paragraph = [line]
        index += 1
        while (index < lines.length) {
          const next = lines[index]
          if (/^\s*$/.test(next) || /^\s*```/.test(next) || /^(#{1,6})\s+/.test(next) || /^\s*>/.test(next)
            || /^\s*[-*+]\s+/.test(next) || /^\s*\d+[.)]\s+/.test(next) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(next)) break
          paragraph.push(next)
          index += 1
        }
        blocks.push(h('p', { key: k(at) }, inlineMd(paragraph.join('\n'), k(at))))
      }
      return blocks
    }

    /** @ 名单：专家 + 专家团，一处来源，评论框和快捷键都用它。 */

  return renderMarkdown
}
