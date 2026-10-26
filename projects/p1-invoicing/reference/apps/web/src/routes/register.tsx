import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import { RegisterForm } from "@/components/AuthForms.tsx";
import { signUp } from "@/lib/auth.ts";

export function RegisterPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-16 text-slate-900">
      <div className="mx-auto flex max-w-sm flex-col gap-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold">Create your Ledgerly account</h1>
        <RegisterForm
          onSubmit={async ({ name, email, password }) => {
            await signUp(queryClient, name, email, password);
            await navigate({ to: "/" });
          }}
        />
        <p className="text-sm">
          Already registered?{" "}
          <Link to="/login" className="text-indigo-700 underline">
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
