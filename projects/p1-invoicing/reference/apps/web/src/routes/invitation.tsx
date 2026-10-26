import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorAlert } from "@/components/Alert.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { primaryButton } from "@/components/ui.ts";
import { api, errorMessage } from "@/lib/api.ts";

interface InvitationView {
  orgName: string;
  email: string;
  role: string;
  status: "pending" | "accepted";
}

export function InvitationPage() {
  const token = useParams({ strict: false }).token ?? "";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, error } = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => api<InvitationView>(`/api/invitations/${encodeURIComponent(token)}`),
  });
  const [pending, setPending] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const accept = async () => {
    setAcceptError(null);
    setPending(true);
    try {
      const result = await api<{ orgId: string }>(
        `/api/invitations/${encodeURIComponent(token)}/accept`,
        {
          body: {},
        },
      );
      await queryClient.invalidateQueries();
      await navigate({ to: "/orgs/$orgId", params: { orgId: result.orgId } });
    } catch (err) {
      setAcceptError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <section className="mx-auto flex max-w-lg flex-col gap-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-bold">Invitation</h1>
      {error && <ErrorAlert message={errorMessage(error)} />}
      {data && (
        <>
          <p className="text-slate-700">
            You have been invited to join {data.orgName} as {data.role.toLowerCase()}
          </p>
          {data.status === "accepted" && (
            <p className="text-sm text-slate-500">This invitation has already been accepted.</p>
          )}
          <ErrorAlert message={acceptError} />
          <div>
            <PendingButton
              type="button"
              className={primaryButton}
              pending={pending}
              onClick={() => void accept()}
            >
              Accept invitation
            </PendingButton>
          </div>
        </>
      )}
    </section>
  );
}
