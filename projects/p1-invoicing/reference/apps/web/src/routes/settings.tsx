import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorAlert, StatusMessage } from "@/components/Alert.tsx";
import { ConfirmDialog } from "@/components/ConfirmDialog.tsx";
import { secondaryButton } from "@/components/ui.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { orgPath, webhookQuery } from "@/lib/data.ts";
import { useOrg } from "@/lib/org-context.ts";

function WebhookSettings({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const { data, error } = useQuery(webhookQuery(orgId));
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-xl font-semibold">Webhook</h2>
      {error && <ErrorAlert message={errorMessage(error)} />}
      {data && (
        <dl className="grid gap-3 text-sm">
          <div>
            <dt className="font-medium">Webhook URL</dt>
            <dd className="font-mono text-xs break-all">{`${window.location.origin}${data.url}`}</dd>
          </div>
          <div>
            <dt className="font-medium">Signing secret</dt>
            <dd className="font-mono text-xs break-all">{data.secret}</dd>
          </div>
        </dl>
      )}
      <StatusMessage message={status} />
      <div>
        <button type="button" className={secondaryButton} onClick={() => setConfirming(true)}>
          Rotate secret
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Rotate the webhook secret?"
          confirmLabel="Confirm rotate"
          pendingLabel="Rotating…"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            const next = await api<{ secret: string; url: string }>(
              `${orgPath(orgId)}/settings/webhook/rotate`,
              {
                body: {},
              },
            );
            queryClient.setQueryData(webhookQuery(orgId).queryKey, next);
            setConfirming(false);
            setStatus("Secret rotated");
          }}
        >
          PayFlow deliveries signed with the current secret will be rejected from now on.
        </ConfirmDialog>
      )}
    </section>
  );
}

export function SettingsPage() {
  const org = useOrg();
  if (org.role !== "owner") {
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-6 text-slate-700">
        Only owners can manage settings
      </p>
    );
  }
  return <WebhookSettings orgId={org.id} />;
}
