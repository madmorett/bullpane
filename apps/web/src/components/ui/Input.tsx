import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
  inline?: boolean;
}

export function Field({ label, hint, error, htmlFor, className, children, inline }: FieldProps) {
  return (
    <div className={cn(inline ? "flex items-center gap-3" : "flex flex-col gap-1", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  mono?: boolean;
  wrapperClassName?: string;
  leftIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, mono, className, wrapperClassName, id, leftIcon, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const control = (
    <div className={cn("relative", leftIcon && "[&_svg]:pointer-events-none")}>
      {leftIcon && (
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle [&_svg]:size-3.5">
          {leftIcon}
        </span>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={cn("control", mono && "font-mono", leftIcon && "pl-8", className)}
        {...rest}
      />
    </div>
  );
  if (!label && !hint && !error) return control;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} className={wrapperClassName}>
      {control}
    </Field>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  mono?: boolean;
  wrapperClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, mono, className, wrapperClassName, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const control = (
    <textarea
      ref={ref}
      id={inputId}
      aria-invalid={error ? true : undefined}
      className={cn("control", mono && "font-mono text-xs", className)}
      {...rest}
    />
  );
  if (!label && !hint && !error) return control;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} className={wrapperClassName}>
      {control}
    </Field>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
  options?: { value: string; label: ReactNode; disabled?: boolean }[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, className, wrapperClassName, id, options, children, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const control = (
    <select
      ref={ref}
      id={inputId}
      aria-invalid={error ? true : undefined}
      className={cn("control", className)}
      {...rest}
    >
      {options
        ? options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))
        : children}
    </select>
  );
  if (!label && !hint && !error) return control;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} className={wrapperClassName}>
      {control}
    </Field>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
  description?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label
      htmlFor={inputId}
      className={cn("flex cursor-pointer items-start gap-2 text-[13px] select-none", className)}
    >
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-[var(--accent)]"
        {...rest}
      />
      {(label || description) && (
        <span className="flex flex-col">
          {label && <span className="text-fg">{label}</span>}
          {description && <span className="text-xs text-fg-subtle">{description}</span>}
        </span>
      )}
    </label>
  );
});

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}

export function Switch({ checked, onChange, disabled, label, className, size = "md" }: SwitchProps) {
  const w = size === "sm" ? "h-4 w-7" : "h-5 w-9";
  const knob = size === "sm" ? "size-3" : "size-4";
  const shift = size === "sm" ? "translate-x-3" : "translate-x-4";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50",
        w,
        checked ? "bg-accent" : "bg-surface-3",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block rounded-full bg-white shadow transition-transform",
          knob,
          checked ? shift : "translate-x-0.5",
        )}
      />
    </button>
  );
}
