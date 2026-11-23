// 确认 / 输入弹窗 —— **我们自己写的**，不是抄 BoardUI 的源码。
//
// BoardUI 的 Modal 是 Pro 组件（公共仓库 404），按既定约束「不买、不复制付费源码」，
// 这里用 react-aria 的 ModalOverlay + Modal + Dialog（免费）拼一个等价物：
//   · 遮罩 bg-black/55，点遮罩或按 Esc 视为取消
//   · 居中卡片 min(440px, 92vw)，圆角 2xl，阴影
//   · 标题 + 说明，可选一个多行输入（提示词/备注这类）
//   · 底部「取消 / 确定」，danger 时确定键走 danger 变体
// 无障碍（焦点锁定、Esc、焦点归还）交给 react-aria。
import type { ReactNode } from "react";
import { useRef } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "../components/base/buttons/button";
import { Textarea } from "../components/base/textarea/textarea";
import { cx } from "../utils/cx";
import { useEscapeFallback, useFocusOnMount, OVERLAY_ATTR } from "./overlay-escape";

export interface ConfirmDialogProps {
  open?: boolean;
  title: ReactNode;
  message?: ReactNode;
  danger?: boolean;
  okText?: string;
  cancelText?: string;
  /** 底部带一个多行输入（true 或初始行数）。 */
  input?: boolean;
  value?: string;
  placeholder?: string;
  onChange?: (next: string) => void;
  onOk: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  danger = false,
  okText = "确定",
  cancelText = "取消",
  input = false,
  value = "",
  placeholder = "",
  onChange,
  onOk,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusOnMount(dialogRef);
  useEscapeFallback(dialogRef, onCancel, open === true);
  return (
    <ModalOverlay
      isOpen={open === true}
      isDismissable
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      className={({ isEntering, isExiting }) =>
        cx(
          "fixed inset-0 z-[95] grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]",
          isEntering && "animate-in fade-in duration-150",
          isExiting && "animate-out fade-out duration-150",
        )
      }
    >
      <Modal
        className={({ isEntering, isExiting }) =>
          cx(
            "w-[min(440px,92vw)] rounded-2xl border border-separator-border",
            "bg-background-primary-default p-5 text-text-primary shadow-xl outline-none",
            isEntering && "animate-in fade-in zoom-in-95 duration-150",
            isExiting && "animate-out fade-out zoom-out-95 duration-150",
          )
        }
      >
        <Dialog ref={dialogRef} tabIndex={-1} {...{ [OVERLAY_ATTR]: "" }} className="outline-none">
          <Heading slot="title" className="text-body-semibold text-text-primary">
            {title}
          </Heading>
          {message === undefined || message === null || message === "" ? null : (
            <p className="mt-1 whitespace-pre-wrap text-body-2-regular leading-relaxed text-text-secondary">
              {message}
            </p>
          )}
          {input ? (
            /* 用 BoardUI 的 Textarea：以前这里是手写样式的原生 <textarea>，
               迁移后成了全库唯一一处「长得像 BoardUI 但不是 BoardUI」的输入框。 */
            <Textarea
              autoFocus
              rows={3}
              value={value}
              placeholder={placeholder}
              /* BoardUI 的 Textarea 走 react-aria：onChange 给的是**字符串**，不是 DOM 事件。
                 以前写成 event.target.value —— 一敲字就 TypeError，所有 prompt 弹窗
                 （标记阻塞、测试计划写「不适用」的理由…）在真机上直接不可用。 */
              onChange={(next) => onChange?.(String(next ?? ""))}
              className="mt-3"
            />
          ) : null}
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="secondary" size="small" onClick={onCancel}>
              {cancelText}
            </Button>
            <Button variant={danger ? "danger" : "primary"} size="small" onClick={onOk}>
              {okText}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
