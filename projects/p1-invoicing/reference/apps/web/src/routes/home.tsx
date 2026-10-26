import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { ErrorAlert } from "@/components/Alert.tsx";
import { TextField } from "@/components/Field.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { primaryButton } from "@/components/ui.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { orgsQuery, ROLE_OPTIONS, type Org } from "@/lib/data.ts";

export function OrgList({ orgs }: { orgs: Org[] }) {
  if (orgs.length === 0) {
    return <p className="text-sm text-slate-600">You are not a member of any organization yet</p>;
  }
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white shadow-sm">
      {orgs.map((org) => (
        <li key={org.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link
            to="/orgs/$orgId"
            params={{ orgId: org.id }}
            className="font-medium break-words text-indigo-700 hover:underline"
          >
            {org.name}
          </Link>
          <span className="text-xs text-slate-500">
            {ROLE_OPTIONS.find((r) => r.value === org.role)?.label ?? org.role}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CreateOrgForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const org = await api<Org>("/api/orgs", { body: { name } });
      await queryClient.invalidateQueries({ queryKey: orgsQuery.queryKey });
      await navigate({ to: "/orgs/$orgId", params: { orgId: org.id } });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      aria-label="New organization"
      className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 className="text-lg font-semibold">New organization</h2>
      <TextField label="Organization name" value={name} onChange={(e) => setName(e.target.value)} />
      <ErrorAlert message={error} />
      <div>
        <PendingButton type="submit" className={primaryButton} pending={pending}>
          Create organization
        </PendingButton>
      </div>
    </form>
  );
}

export function HomePage() {
  const { data: orgs, error, isPending } = useQuery(orgsQuery);
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">Your organizations</h1>
        {isPending && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <ErrorAlert message={errorMessage(error)} />}
        {orgs && <OrgList orgs={orgs} />}
      </div>
      <CreateOrgForm />
    </section>
  );
}
