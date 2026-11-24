// BoardUI 适配层：原样引入的组件（TSX 未改）在这里接到我们现有调用点。
// 我们的调用方用 variant="default|secondary|ghost|destructive|link"、size="default|sm|lg|icon"，
// BoardUI 用 primary|secondary|ghost|danger 与 medium|small|xs —— 这里只做名字映射，不重写样式。
import { Button as BoarduiButton, ButtonLink as BoarduiButtonLink } from "../components/base/buttons/button";
import { TextField as BoarduiField, InputBase as BoarduiInputBase } from "../components/base/input/input";
import { TextareaBase as BoarduiTextareaBase } from "../components/base/textarea/textarea";
import { Checkbox as BoarduiCheckboxBase } from "../components/base/checkbox/checkbox";
import { Select as BoarduiSelect, SelectItem as BoarduiSelectItem } from "../components/base/select/select";
import { SearchField as BoarduiSearchField } from "../components/base/search-field/search-field";
import { Chip as BoarduiChip } from "../components/base/badges/chip";
import { Switch as BoarduiSwitch } from "../components/base/switch/switch";
import { SegmentedControl as BoarduiSegmented, SegmentedControlItem as BoarduiSegmentedItem } from "../components/base/segmented-control/segmented-control";
import { DatePicker as BoarduiDatePicker } from "../components/base/date-picker/date-picker";
import { CalendarDate, parseDate } from "@internationalized/date";

/* 树形视图（BoardUI tree-view）：文件树用。组件源码原样放在 components/base/tree-view，
   只去掉了上游的 motion 展开动画（见该文件头注）。 */
export { TreeView, TreeViewItem } from "../components/base/tree-view/tree-view";

const VARIANT = {
  default: "primary",
  primary: "primary",
  secondary: "secondary",
  outline: "secondary",
  ghost: "ghost",
  destructive: "danger",
  // 调用点两种写法都有（`danger` 与 `destructive`）；以前 danger 没登记 → 落到 primary，
  // 12 个「删除」按钮全变成主色蓝，危险操作在界面上没有视觉语言（unslop 体检 S6）。
  danger: "danger",
  link: "ghost",
} as const;

const SIZE = { default: "medium", sm: "small", xs: "xs", lg: "medium", icon: "medium" } as const;

/** 与原来 shadcn Button 同名的薄适配：传进来的 variant/size 自动翻译成 BoardUI 的取值。 */
export function Button({ variant = "default", size = "default", ...rest }: any) {
  // data-variant 是给 CSS 用的稳定钩子：BoardUI 的颜色工具类在这个宿主页里不一定生效
  // （见 index.css 里那段说明），所以按钮底色/描边由我们自己按变体写死。
  return (
    <BoarduiButton
      variant={VARIANT[variant] ?? "primary"}
      size={SIZE[size] ?? "medium"}
      data-variant={VARIANT[variant] ?? "primary"}
      data-size={SIZE[size] ?? "medium"}
      {...rest}
    />
  );
}

/** 原样导出，想直接用他们 API（leadingIcon / iconOnly）时走这个。 */
export { BoarduiButton as ButtonBase, BoarduiButtonLink as ButtonLink };

/* -------------------------------------------------------------------------- */
/* 表单控件：把 legacy 的 value / onChange(e) 语义翻译成 react-aria 的           */
/* value / onChange(string)。组件本体仍是 BoardUI 源码（TextField + InputBase）。 */
/* 迁移已收官，调用点不再传手写样式类，这里只保留传入的 Tailwind 类。             */
/* -------------------------------------------------------------------------- */

function extraClasses(className: unknown): string {
  return String(className ?? "")
    .split(/\s+/)
    .filter((name) => name !== "")
    .join(" ");
}

/** react-aria 要求字段有可访问名：没给 aria-label 就退到 placeholder / title。 */
function fieldLabel(rest: Record<string, any>, key = "placeholder"): string | undefined {
  const explicit = rest["aria-label"] ?? rest["aria-labelledby"];
  if (typeof explicit === "string" && explicit !== "") return explicit;
  const fallback = rest[key] ?? rest.title;
  return typeof fallback === "string" && fallback !== "" ? fallback : undefined;
}

/** 把 DOM 事件语义的 onChange 包一层，保持 e.target.value。 */
function valueHandler(onChange: unknown) {
  return (next: string) => {
    if (typeof onChange === "function") onChange({ target: { value: next } });
  };
}

export function Input({
  className,
  style,
  value,
  defaultValue,
  onChange,
  disabled,
  readOnly,
  required,
  /** 外部要拿到底层 <input> 时传这个（React 18 下普通函数组件拿不到 ref）。 */
  inputRef,
  ...rest
}: any) {
  return (
    <BoarduiField
      className={["w-full", extraClasses(className)].filter(Boolean).join(" ")}
      data-field="input"
      style={style}
      value={value === undefined || value === null ? undefined : String(value)}
      defaultValue={defaultValue === undefined || defaultValue === null ? undefined : String(defaultValue)}
      onChange={valueHandler(onChange)}
      isDisabled={disabled === true}
      isReadOnly={readOnly === true}
      isRequired={required === true}
      aria-label={fieldLabel(rest)}
    >
      <BoarduiInputBase ref={inputRef} {...rest} aria-label={fieldLabel(rest)} />
    </BoarduiField>
  );
}

export function Textarea({
  className,
  style,
  value,
  defaultValue,
  onChange,
  disabled,
  readOnly,
  required,
  rows,
  ...rest
}: any) {
  const rowCount = Number(rows) > 0 ? Number(rows) : 4;
  return (
    <BoarduiField
      className={["w-full", extraClasses(className)].filter(Boolean).join(" ")}
      data-field="input"
      style={style}
      value={value === undefined || value === null ? undefined : String(value)}
      defaultValue={defaultValue === undefined || defaultValue === null ? undefined : String(defaultValue)}
      onChange={valueHandler(onChange)}
      isDisabled={disabled === true}
      isReadOnly={readOnly === true}
      isRequired={required === true}
      aria-label={fieldLabel(rest)}
    >
      <BoarduiTextareaBase rows={rowCount} {...rest} aria-label={fieldLabel(rest)} />
    </BoarduiField>
  );
}

/** 搜索框：语义组件（自带放大镜与清除键）。size="sm" 是 32px，看板工具栏的高度。 */
export function SearchInput({ className, style, value, onChange, placeholder, ...rest }: any) {
  return (
    <BoarduiSearchField
      {...rest}
      data-field="search"
      className={extraClasses(className)}
      style={style}
      size="sm"
      placeholder={placeholder}
      aria-label={fieldLabel(rest, "placeholder")}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={valueHandler(onChange)}
    />
  );
}

export function Checkbox({ className, checked, onChange, disabled, bare, children, ...rest }: any) {
  void className;
  void bare; // legacy 的 SwitchBox 开关标记，BoardUI 的 Checkbox 不需要
  /* children 是勾选框旁边的文字（legacy 用法：h(CheckField, {...}, '隐藏空列')）。
     BoardUI 的 Checkbox 自带 label 关联：传 children 进去它会渲染 <label>+文字，
     可访问名也由它给出。以前这里把 children 丢了 —— 专家团「成员」只剩一排没有文字的
     方框，就是这条走的。没有 children 时保持裸控件（外面自己用 <label> 包着的那些调用点
     不能套出嵌套 label）。 */
  const hasText = children !== undefined && children !== null && children !== "";
  return (
    <BoarduiCheckboxBase
      isSelected={checked === true}
      isDisabled={disabled === true}
      aria-label={hasText ? undefined : (typeof rest["aria-label"] === "string" ? rest["aria-label"] : rest.title)}
      onChange={(next: boolean) => {
        if (typeof onChange === "function") onChange({ target: { checked: next } });
      }}
    >
      {hasText ? children : null}
    </BoarduiCheckboxBase>
  );
}

/** react-aria 的 key 不接受空字符串当可选项，空值统一走这个哨兵再映射回 ''。 */
const EMPTY_KEY = "__empty__";

export function Select({
  className,
  style,
  value,
  onChange,
  disabled,
  options,
  ...rest
}: any) {
  const list: Array<{ value: string; label: string }> =
    Array.isArray(options) && options.length > 0 ? options : [{ value: "", label: "—" }];
  const hasEmpty = list.some((option) => option.value === "");
  const toKey = (raw: string) => (hasEmpty && raw === "" ? EMPTY_KEY : raw);
  const current = value === undefined || value === null ? "" : String(value);
  const selected = list.find((option) => option.value === current);
  return (
    <BoarduiSelect
      {...rest}
      data-field="select"
      className={extraClasses(className)}
      style={style}
      isDisabled={disabled === true}
      aria-label={
        (typeof rest["aria-label"] === "string" && rest["aria-label"]) ||
        (typeof rest.title === "string" && rest.title) ||
        selected?.label ||
        "下拉选择"
      }
      selectedKey={toKey(current)}
      onSelectionChange={(key: any) => {
        if (typeof onChange !== "function") return;
        onChange({ target: { value: key === EMPTY_KEY ? "" : String(key) } });
      }}
    >
      {list.map((option) => (
        <BoarduiSelectItem key={option.value} id={toKey(option.value)} textValue={option.label}>
          {option.label}
        </BoarduiSelectItem>
      ))}
    </BoarduiSelect>
  );
}

/* -------------------------------------------------------------------------- */
/*  状态标签：颜色由 variant / data-* 语义决定（迁移前是手写徽章类）。          */
/* -------------------------------------------------------------------------- */

export function Chip({ variant, ...rest }: any) {
  const color =
    variant ??
    (rest["data-blocked"] === "1" || rest["data-danger"] === "1"
      ? "rose"
      : rest["data-svc-missing"] === "1"
        ? "soft"
        : "gray");
  // caption 是 12/16/500 —— 与原来 11px 的小标签最接近，换 bold(14) 会把行高撑起来
  return <BoarduiChip variant="caption" color={color} {...rest} />;
}

/* -------------------------------------------------------------------------- */
/*  开关：启用/停用这类「即时生效的布尔状态」用官方 Switch（语义与勾选框不同）。   */
/*  legacy 写法 h(CheckField, { checked, onChange(e) }) 与勾选框一致，所以适配层   */
/*  也保持同一套入参，只是换成带滑块的 Switch。                                   */
/* -------------------------------------------------------------------------- */

export function SwitchField({ className, checked, onChange, disabled, bare, label, ...rest }: any) {
  void className;
  void bare;
  return (
    <BoarduiSwitch
      isSelected={checked === true}
      isDisabled={disabled === true}
      aria-label={typeof rest['aria-label'] === 'string' ? rest['aria-label'] : (typeof label === 'string' ? label : rest.title)}
      onChange={(next: boolean) => {
        if (typeof onChange === 'function') onChange({ target: { checked: next } });
      }}
    >
      {label === undefined || label === null || label === '' ? null : label}
    </BoarduiSwitch>
  );
}

/* -------------------------------------------------------------------------- */
/*  日期：官方 DatePicker 用 CalendarDate，我们调用点传 YYYY-MM-DD 字符串，这里互转。 */
/* -------------------------------------------------------------------------- */

export function DateField({ value, onChange, disabled, ...rest }: any) {
  const text = typeof value === "string" ? value.trim() : "";
  const date = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) ? parseDate(text) : null;
  return (
    <BoarduiDatePicker
      {...rest}
      value={date}
      isDisabled={disabled === true}
      onChange={(next: CalendarDate | null) => {
        if (typeof onChange === "function") onChange({ target: { value: next === null ? "" : next.toString() } });
      }}
    />
  );
}

/** 分段控件（BoardUI segmented-control）：value + onChange，和 studio 其它控件同一种回调形状。 */
export function SegmentedControl({ value, onChange, options = [], className, ...rest }: any) {
  const items: Array<{ value: string; label: string }> = Array.isArray(options) ? options : [];
  return (
    <BoarduiSegmented {...rest} className={["flex w-full", className].filter(Boolean).join(" ")} selectedKeys={[String(value ?? "")]} onSelectionChange={(keys: any) => {
      const next = Array.from(keys as Set<string>)[0];
      if (typeof onChange === "function" && next !== undefined) onChange(String(next));
    }}>
      {items.map((item) => (
        <BoarduiSegmentedItem key={item.value} id={item.value} className="flex-1">{item.label}</BoarduiSegmentedItem>
      ))}
    </BoarduiSegmented>
  );
}
