import { useState } from "react";

import { errorMessage } from "@/lib/api.ts";

/** Tracks one server action: pending flag, last error and last success message. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, successMessage?: string): Promise<boolean> {
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      if (successMessage) setSuccess(successMessage);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  }

  return { pending, error, success, run, setError };
}
