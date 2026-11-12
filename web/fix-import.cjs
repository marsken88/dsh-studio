const fs = require('fs')
let m = fs.readFileSync('src/main.jsx', 'utf8')
m = m.replace(/import\s*\{([^}]*)\}\s*from\s*'\.\/components\/studio-ui\.jsx'/, (full, names) => {
  const uniq = Array.from(new Set(names.split(',').map((s) => s.trim()).filter(Boolean)))
  return `import { ${uniq.join(', ')} } from './components/studio-ui.jsx'`
})
fs.writeFileSync('src/main.jsx', m)
console.log('dedupe ok')
