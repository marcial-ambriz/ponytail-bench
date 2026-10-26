import { useState, type FormEvent } from "react";

import { errorMessage } from "@/lib/api.ts";

import { ErrorAlert } from "./Alert.tsx";
import { TextField } from "./Field.tsx";
import { PendingButton } from "./PendingButton.tsx";
import { primaryButton as buttonClass } from "./ui.ts";

function useSubmit<T>(onSubmit: (values: T) => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (values: T) => {
    setError(null);
    setPending(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return { error, pending, submit };
}

export interface LoginValues {
  email: string;
  password: string;
}

export function LoginForm({ onSubmit }: { onSubmit: (values: LoginValues) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { error, pending, submit } = useSubmit(onSubmit);

  const handle = (event: FormEvent) => {
    event.preventDefault();
    void submit({ email, password });
  };

  return (
    <form noValidate onSubmit={handle} className="flex flex-col gap-4">
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <ErrorAlert message={error} />
      <PendingButton type="submit" className={buttonClass} pending={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </PendingButton>
    </form>
  );
}

export interface RegisterValues extends LoginValues {
  name: string;
}

export function RegisterForm({
  onSubmit,
}: {
  onSubmit: (values: RegisterValues) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { error, pending, submit } = useSubmit(onSubmit);

  const handle = (event: FormEvent) => {
    event.preventDefault();
    void submit({ name, email, password });
  };

  return (
    <form noValidate onSubmit={handle} className="flex flex-col gap-4">
      <TextField
        label="Name"
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <ErrorAlert message={error} />
      <PendingButton type="submit" className={buttonClass} pending={pending}>
        {pending ? "Creating account…" : "Create account"}
      </PendingButton>
    </form>
  );
}
