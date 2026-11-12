import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import scopeToStudio from './scripts/scope-css.mjs'

export default {
  plugins: [tailwindcss(), autoprefixer(), scopeToStudio()],
}
