export function ErrorAlert({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
    >
      {message}
    </p>
  );
}

export function StatusMessage({ message }: { message: string | null | undefined }) {
  return (
    <p role="status" className="min-h-5 text-sm text-green-700">
      {message ?? ""}
    </p>
  );
}
