// Mounts the bundled React tree (legacy panel + shadcn primitives) inside a slot
// that the host renders with *its own* React.
//
// Two React copies cannot share a render tree, so the bridge does the smallest
// possible thing in the host tree — a class component that renders one empty div
// — and drives its own root inside it. Element objects still interoperate, so the
// host can render the sidebar icon we build with the bundled React.
import * as React from 'react'
import { createRoot } from 'react-dom/client'

// Keeps one broken component from unmounting the whole panel with a blank page.
class Boundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    // eslint-disable-next-line no-console
    console.error('[dsh-studio] render failed:', error)
  }

  render() {
    if (this.state.error) {
      return React.createElement(
        'div',
        {
          style: {
            padding: '16px 18px',
            fontSize: '12px',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            color: '#b31d28',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          },
        },
        '工作空间渲染失败：\n' + String(this.state.error?.message ?? this.state.error),
      )
    }
    return this.props.children
  }
}

export function createBridge(studio, hostReact, options = {}) {
  class StudioBridge extends hostReact.Component {
    constructor(props) {
      super(props)
      this.container = null
      this.root = null
      this.attach = (element) => {
        this.container = element
      }
    }

    componentDidMount() {
      if (!this.container) return
      this.root = createRoot(this.container)
      this.root.render(
        React.createElement(
          Boundary,
          null,
          React.createElement(studio.StudioPage, options.pageProps ?? {}),
        ),
      )
    }

    componentWillUnmount() {
      const root = this.root
      this.root = null
      if (root) root.unmount()
    }

    render() {
      // display:contents keeps the host's layout as if the div were not there.
      return hostReact.createElement('div', { ref: this.attach, style: { display: 'contents' } })
    }
  }
  StudioBridge.displayName = 'StudioBridge'
  return StudioBridge
}
