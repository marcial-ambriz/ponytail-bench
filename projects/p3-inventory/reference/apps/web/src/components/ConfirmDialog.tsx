import { useState, type ReactNode } from "react";

import { errorMessage } from "@/lib/api.ts";

import { ErrorAlert } from "./Alert.tsx";
import { Dialog } from "./Dialog.tsx";
import { PendingButton } from "./PendingButton.tsx";
import { dangerButton } from "./ui.ts";

interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  /** Label shown while the action is in flight, e.g. "Deleting…". */
  pendingLabel?: string;
  children: ReactNode;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** Confirmation dialog that keeps itself open and shows the server error when the action fails. */
export function ConfirmDialog({
  title,
  confirmLabel,
  pendingLabel = "Working…",
  children,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    setError(null);
    setPending(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="text-sm text-slate-700">{children}</div>
        <ErrorAlert message={error} />
        <PendingButton
          type="button"
          className={dangerButton}
          pending={pending}
          onClick={() => void confirm()}
        >
          {pending ? pendingLabel : confirmLabel}
        </PendingButton>
      </div>
    </Dialog>
  );
}
