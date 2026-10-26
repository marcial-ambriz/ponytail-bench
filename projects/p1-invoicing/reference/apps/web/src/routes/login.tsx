import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import { LoginForm } from "@/components/AuthForms.tsx";
import { signIn } from "@/lib/auth.ts";

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-16 text-slate-900">
      <div className="mx-auto flex max-w-sm flex-col gap-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold">Sign in to Ledgerly</h1>
        <LoginForm
          onSubmit={async ({ email, password }) => {
            await signIn(queryClient, email, password);
            await navigate({ to: "/" });
          }}
        />
        <p className="text-sm">
          No account yet?{" "}
          <Link to="/register" className="text-indigo-700 underline">
            Register
          </Link>
        </p>
      </div>
    </main>
  );
}
