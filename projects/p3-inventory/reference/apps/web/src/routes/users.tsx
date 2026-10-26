import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { ErrorAlert, StatusMessage } from "@/components/Alert.tsx";
import { Loading, PageHeader } from "@/components/Page.tsx";
import { cellClass, DataTable } from "@/components/Table.tsx";
import { inputClass } from "@/components/ui.ts";
import { useAction } from "@/components/useAction.ts";
import { errorMessage } from "@/lib/api.ts";
import type { Role, User } from "@/lib/auth.ts";
import { updateUserRole, usersQuery } from "@/lib/inventory.ts";

function RoleSelect({ user, onChange }: { user: User; onChange: (role: Role) => void }) {
  const id = useId();
  const [role, setRole] = useState<Role>(user.role);
  return (
    <>
      <label htmlFor={id} className="sr-only">
        Role
      </label>
      <select
        id={id}
        className={`${inputClass} max-w-32`}
        value={role}
        onChange={(e) => {
          const next: Role = e.target.value === "admin" ? "admin" : "clerk";
          setRole(next);
          onChange(next);
        }}
      >
        <option value="admin">admin</option>
        <option value="clerk">clerk</option>
      </select>
    </>
  );
}

export function UsersPage() {
  const queryClient = useQueryClient();
  const users = useQuery(usersQuery);
  const { error, success, run } = useAction();
  const [version, setVersion] = useState(0);

  const change = async (user: User, role: Role) => {
    const ok = await run(() => updateUserRole(user.id, role), "Role updated");
    await queryClient.invalidateQueries({ queryKey: ["users"] });
    if (!ok) setVersion((v) => v + 1); // remount selects so they show the stored role again
  };

  return (
    <div>
      <PageHeader title="Users" />
      <div className="mb-3 flex flex-col gap-2">
        <ErrorAlert message={error} />
        <StatusMessage message={success} />
      </div>
      {users.isPending ? (
        <Loading />
      ) : users.isError ? (
        <ErrorAlert message={errorMessage(users.error)} />
      ) : (
        <DataTable headers={["Name", "Email", "Role"]}>
          {users.data.map((u) => (
            <tr key={`${u.id}-${version}`}>
              <td className={cellClass}>{u.name}</td>
              <td className={cellClass}>{u.email}</td>
              <td className={cellClass}>
                <RoleSelect user={u} onChange={(role) => void change(u, role)} />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
