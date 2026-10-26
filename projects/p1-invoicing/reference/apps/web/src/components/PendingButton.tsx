import type { ButtonHTMLAttributes } from "react";

interface PendingButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  pending: boolean;
}

/**
 * Button that shows a spinner and is disabled while its server request is in flight.
 * The spinner is aria-hidden so the accessible name stays the button's label.
 */
export function PendingButton({
  pending,
  disabled,
  className,
  children,
  ...props
}: PendingButtonProps) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 ${className ?? ""}`}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
    >
      {pending && (
        <span
          aria-hidden="true"
          className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
