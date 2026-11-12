/* Small form/display adapters: prefer the host-provided shadcn component,
   fall back to the plain DOM element when the host did not hand one over.
   They only need `h` and `kit`, so they are created by a factory instead of
   importing the panel runtime. */

export function createFields({ h, kit, React }) {
    function TextField({ className, ...rest }) {
      const Input = kit('Input')
      if (Input === null) return h('input', { className, ...rest })
      const { style, ...props } = rest
      const extra = String(className ?? '')
        .split(/\s+/)
        .filter(name => name !== '' && name !== 'ds-input')
        .join(' ')
      return h(Input, {
        ...props,
        style,
        className: `h-9 w-full min-w-0 text-sm${extra === '' ? '' : ' ' + extra}`,
      })
    }
    function TextAreaField({ className, ...rest }) {
      const Textarea = kit('Textarea')
      if (Textarea === null) return h('textarea', { className, ...rest })
      const { style, ...props } = rest
      const rows = Number(props.rows) > 0 ? Number(props.rows) : 4
      const extra = String(className ?? '').split(/\s+/).filter(name => name !== '' && name !== 'ds-input' && name !== 'ds-textarea').join(' ')
      return h(Textarea, {
        ...props,
        style: { minHeight: `${Math.max(96, rows * 22 + 28)}px`, ...(style ?? {}) },
        className: `flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed shadow-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50${extra === '' ? '' : ' ' + extra}`,
      })
    }
    function ChipField({ className, variant, ...rest }) {
      const Badge = kit('Badge')
      if (Badge === null) return h('span', { className, ...rest })
      const into = String(className ?? '')
      const next = variant ?? (into.indexOf('ds-chip-blocked') >= 0 || into.indexOf('ds-chip-bug') >= 0 || rest['data-blocked'] === '1' || rest['data-danger'] === '1'
        ? 'destructive'
        : into.indexOf('ds-chip-code') >= 0 || rest['data-svc-missing'] === '1'
          ? 'outline'
          : 'secondary')
      return h(Badge, { ...rest, variant: next, className })
    }
    function CheckField({ className, checked, onChange, disabled, ...rest }) {
      const Switch = kit('SwitchBox')
      if (Switch === null) {
        return h('input', { className, type: 'checkbox', checked: checked === true, disabled, onChange, ...rest })
      }
      return h(Switch, {
        bare: true,
        checked: checked === true,
        disabled: disabled === true,
        onChange: next => { if (typeof onChange === 'function') onChange({ target: { checked: next === true } }) },
      })
    }
    function optionListOf(children) {
    const out = []
    React.Children.forEach(children, child => {
      if (!React.isValidElement(child)) return
      if (child.type === 'option') {
        out.push({ value: String(child.props.value ?? ''), label: String(React.Children.toArray(child.props.children).join('')) })
      } else if (child.type === 'optgroup') {
        optionListOf(child.props.children).forEach(item => out.push(item))
      }
    })
    return out
  }
  function SelectField({ className, children, value, onChange, disabled, ...rest }) {
      const Select = kit('SelectBox')
      if (Select === null) {
        return h('select', { className, value, onChange, disabled, ...rest }, children)
      }
      const raw = optionListOf(children)
      // Radix Select 不接受空字符串作为可展示项：有空值选项时用哨兵值代替，对外仍映射成 ''。
      const hasEmpty = raw.some(option => option.value === '')
      const options = raw.map(option => (hasEmpty && option.value === '' ? { ...option, value: '__empty__' } : option))
      if (options.length === 0) options.push({ value: hasEmpty ? '__empty__' : '', label: '—' })
      const current = value === undefined || value === null ? '' : String(value)
      return h(Select, {
        ...rest,
        value: hasEmpty && current === '' ? '__empty__' : current,
        options,
        disabled,
        onChange: next => {
          if (typeof onChange !== 'function') return
          onChange({ target: { value: next === '__empty__' ? '' : next } })
        },
      })
    }

  return { TextField, TextAreaField, ChipField, CheckField, SelectField }
}
