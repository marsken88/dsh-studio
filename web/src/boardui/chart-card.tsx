// 统计卡 / 图表卡 —— **我们自己写的** Pro 等价物。
//
// BoardUI 的 Chart cards / stats 是 Pro 组件（公共仓库里没有），按约束不买不抄。
// 这里照它们公开文档里的样子（标题 + 一句话说明 + 主数字 + 趋势 + 图 + 脚注），
// 用他们 MIT 的 token 拼出三个小组件，给效能页复用：
//
//   StatCard   —— 一个 KPI 方块：标签 / 主数字 / 一句解释，超阈值时数字变红
//   ChartCard  —— 图表外壳：标题 + 右侧附注 + 内容 + 脚注
//   BarRow     —— 卡片里的一行横条：名字 / 轨道 / 数值
//
// 只依赖 token，不引入任何图表库 —— 我们的「图」就是横条与柱状 div，够用且不涨体积。
import type { ReactNode } from "react";
import { cx } from "../utils/cx";

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  /** 超阈值（比如返工率偏高）时主数字走错误色，和看板上的告警保持同一套语义。 */
  warn?: boolean;
  className?: string;
}

export function StatCard({ label, value, hint, warn = false, className }: StatCardProps) {
  return (
    <div
      data-stat-card=""
      className={cx(
        "flex min-w-0 flex-col gap-1 rounded-2xl border border-separator-border",
        "bg-background-primary-default p-4 shadow-xs",
        className,
      )}
    >
      <div className="text-caption-1-medium text-text-secondary">{label}</div>
      <div
        className={cx(
          "text-title-2-semibold tabular-nums",
          warn ? "text-text-error-primary" : "text-text-primary",
        )}
      >
        {value}
      </div>
      {hint === undefined || hint === null || hint === "" ? null : (
        <div className="text-caption-1-regular text-text-secondary">{hint}</div>
      )}
    </div>
  );
}

export interface ChartCardProps {
  title: ReactNode;
  /** 标题右边的小字（总数、区间之类）。 */
  aside?: ReactNode;
  /** 标题下面那句「所以呢」。 */
  hint?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function ChartCard({ title, aside, hint, footer, className, children }: ChartCardProps) {
  return (
    <div
      data-chart-card=""
      className={cx(
        "flex min-w-0 flex-col overflow-hidden rounded-2xl border border-separator-border",
        "bg-background-primary-default shadow-xs",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-separator-border px-4 py-3">
        <span className="text-body-medium text-text-primary">{title}</span>
        {aside === undefined || aside === null || aside === "" ? null : (
          <span className="ms-auto text-caption-1-medium text-text-tertiary">{aside}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 px-4 py-3">
        {hint === undefined || hint === null || hint === "" ? null : (
          <div className="text-caption-1-regular text-text-tertiary">{hint}</div>
        )}
        {children}
      </div>
      {footer === undefined || footer === null || footer === "" ? null : (
        <div className="border-t border-separator-border px-4 py-2 text-caption-1-regular text-text-tertiary">
          {footer}
        </div>
      )}
    </div>
  );
}

export interface BarRowProps {
  label: ReactNode;
  /** 0–1 之间的比例，用来算填充宽度。 */
  ratio: number;
  display?: ReactNode;
  /** 强调条（比如「最慢的那一列」）。 */
  tone?: "accent" | "warn";
  title?: string;
}

export function BarRow({ label, ratio, display, tone = "accent", title }: BarRowProps) {
  const width = Math.max(ratio <= 0 ? 0 : 3, Math.round(Math.min(1, Math.max(0, ratio)) * 100));
  return (
    <div className="flex min-w-0 items-center gap-3" title={title}>
      <span className="w-24 shrink-0 truncate text-body-2-medium text-text-secondary">{label}</span>
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-background-tertiary-default">
        <span
          className={cx(
            "block h-full rounded-full transition-[width] duration-300 ease",
            ratio <= 0 ? "bg-transparent" : tone === "warn" ? "bg-accent-600" : "bg-accent-500",
          )}
          style={{ width: `${ratio <= 0 ? 0 : width}%` }}
        />
      </span>
      <span className="w-16 shrink-0 text-end text-caption-1-medium tabular-nums text-text-primary">
        {display}
      </span>
    </div>
  );
}
