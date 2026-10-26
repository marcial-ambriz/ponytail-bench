import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { ErrorAlert, StatusMessage } from "@/components/Alert.tsx";
import { ConfirmDialog } from "@/components/ConfirmDialog.tsx";
import { TextField } from "@/components/Field.tsx";
import { PendingButton } from "@/components/PendingButton.tsx";
import { cellClass, DataTable, EmptyState } from "@/components/Table.tsx";
import { inputClass, primaryButton, secondaryButton } from "@/components/ui.ts";
import { api, errorMessage } from "@/lib/api.ts";
import {
  invitationsQuery,
  membersQuery,
  orgPath,
  ROLE_OPTIONS,
  type Member,
  type Role,
} from "@/lib/data.ts";
import { useOrg } from "@/lib/org-context.ts";

const isRole = (v: string): v is Role => v === "owner" || v === "accountant" || v === "viewer";
const roleLabel = (role: Role) => ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;

function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: Role;
  onChange: (r: Role) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label="Role"
      className={inputClass}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (isRole(e.target.value)) onChange(e.target.value);
      }}
    >
      {ROLE_OPTIONS.map((r) => (
        <option key={r.value} value={r.value}>
          {r.label}
        </option>
      ))}
    </select>
  );
}

function InviteForm({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("accountant");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { data: invitations = [] } = useQuery(invitationsQuery(orgId));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setStatus(null);
    setPending(true);
    try {
      await api(`${orgPath(orgId)}/invitations`, { body: { email, role } });
      await queryClient.invalidateQueries({ queryKey: invitationsQuery(orgId).queryKey });
      setEmail("");
      setStatus("Invitation created");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <form
        noValidate
        aria-label="Invite member"
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 className="text-lg font-semibold">Invite member</h2>
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-role" className="text-sm font-medium">
              Role
            </label>
            <select
              id="invite-role"
              className={inputClass}
              value={role}
              onChange={(e) => {
                if (isRole(e.target.value)) setRole(e.target.value);
              }}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ErrorAlert message={error} />
        <StatusMessage message={status} />
        <div>
          <PendingButton type="submit" className={primaryButton} pending={pending}>
            Send invitation
          </PendingButton>
        </div>
      </form>
      <h2 className="text-lg font-semibold">Pending invitations</h2>
      <DataTable
        headers={["Email", "Role", "Link"]}
        empty={invitations.length === 0 ? <EmptyState>No pending invitations</EmptyState> : null}
      >
        {invitations.map((inv) => (
          <tr key={inv.id}>
            <td className={`${cellClass} break-all`}>{inv.email}</td>
            <td className={cellClass}>{roleLabel(inv.role)}</td>
            <td className={`${cellClass} break-all font-mono text-xs`}>
              {`${window.location.origin}/invitations/${inv.token}`}
            </td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}

export function MembersPage() {
  const org = useOrg();
  const queryClient = useQueryClient();
  const { data: members = [], error: loadError } = useQuery(membersQuery(org.id));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ userId: string; role: Role } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const isOwner = org.role === "owner";

  const changeRole = async (member: Member, role: Role) => {
    setError(null);
    setStatus("Saving role…");
    setSaving({ userId: member.userId, role });
    try {
      await api(`${orgPath(org.id)}/members/${encodeURIComponent(member.userId)}`, {
        method: "PATCH",
        body: { role },
      });
      await queryClient.invalidateQueries({ queryKey: ["org", org.id] });
      setStatus("Role updated");
    } catch (err) {
      setStatus(null);
      setError(errorMessage(err));
      await queryClient.invalidateQueries({ queryKey: membersQuery(org.id).queryKey });
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Members</h2>
        {loadError && <ErrorAlert message={errorMessage(loadError)} />}
        <ErrorAlert message={error} />
        <StatusMessage message={status} />
        <DataTable headers={["Name", "Email", "Role"]}>
          {members.map((m) => (
            <tr key={m.userId}>
              <td className={cellClass}>{m.name}</td>
              <td className={`${cellClass} break-all`}>{m.email}</td>
              <td className={cellClass}>
                {isOwner ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-32 flex-1">
                      <RoleSelect
                        value={saving?.userId === m.userId ? saving.role : m.role}
                        disabled={saving !== null}
                        onChange={(role) => void changeRole(m, role)}
                      />
                    </div>
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => setRemoving(m)}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  roleLabel(m.role)
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      </div>
      {isOwner && <InviteForm orgId={org.id} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Confirm remove"
          pendingLabel="Removing…"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`${orgPath(org.id)}/members/${encodeURIComponent(removing.userId)}`, {
              method: "DELETE",
            });
            setRemoving(null);
            setStatus("Member removed");
            await queryClient.invalidateQueries({ queryKey: ["org", org.id] });
          }}
        >
          {removing.name} will lose access to {org.name} immediately.
        </ConfirmDialog>
      )}
    </section>
  );
}
