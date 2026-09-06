import { useState } from "react";
import { RefreshCw, Trash2, UserPlus } from "lucide-react";
import { ROLES, createUserSchema, type Role, type User } from "@bullmq-visualizer/shared";
import { useCreateUser, useDeleteUser, useUpdateUser, useUsers } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { RequireRole } from "@/auth/guards";
import { useEdition } from "@/edition/useEdition";
import { LockedFeature } from "@/edition/LockedFeature";
import { toast } from "@/components/Toast";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { Table, TableMessage, Td, Th } from "@/components/ui/Table";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const ROLE_HELP: Record<Role, string> = {
  admin: "Everything, including connections, users, license, drain and obliterate.",
  operator: "Manage jobs and queues, alerts, folders and flow edges. No settings.",
  viewer: "Read-only access to queues, jobs, alerts and flows.",
};

export function UsersPage() {
  const { has } = useEdition();
  if (!has("users")) return <LockedFeature feature="users" />;
  return (
    <RequireRole role="admin">
      <UsersManager />
    </RequireRole>
  );
}

function UsersManager() {
  const { user: me } = useAuth();
  const users = useUsers();
  const update = useUpdateUser();
  const del = useDeleteUser();
  const [invite, setInvite] = useState(false);
  const [deleting, setDeleting] = useState<User | null>(null);

  const list = [...(users.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const admins = list.filter((u) => u.role === "admin").length;

  return (
    <Page>
      <PageHeader
        title="Users"
        description="Roles are enforced on every API call, not only in the UI."
        actions={
          <Button variant="primary" size="sm" leftIcon={<UserPlus />} onClick={() => setInvite(true)}>
            Invite user
          </Button>
        }
      />
      <div className="card overflow-hidden">
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th className="w-40">Role</Th>
              <Th>Created</Th>
              <Th>Last login</Th>
              <Th align="right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {users.isLoading && (
              <TableMessage colSpan={6}>
                <Spinner label="Loading users…" />
              </TableMessage>
            )}
            {users.isError && (
              <TableMessage colSpan={6} className="text-danger">
                {errorMessage(users.error)}
              </TableMessage>
            )}
            {list.map((u) => {
              const isMe = u.id === me?.id;
              const lastAdmin = u.role === "admin" && admins <= 1;
              const deleteBlocked = isMe ? "You cannot delete your own account" : lastAdmin ? "Cannot delete the last admin" : null;
              return (
                <tr key={u.id}>
                  <Td className="font-medium">
                    {u.name}
                    {isMe && (
                      <Badge variant="outline" size="xs" className="ml-1.5">
                        you
                      </Badge>
                    )}
                  </Td>
                  <Td muted>{u.email}</Td>
                  <Td>
                    <Tooltip content={isMe ? "Ask another admin to change your role" : lastAdmin ? "Promote someone else to admin first" : ROLE_HELP[u.role]} block>
                      <Select
                        aria-label={`Role of ${u.name}`}
                        className="!h-7 text-xs"
                        value={u.role}
                        disabled={isMe || lastAdmin || (update.isPending && update.variables?.id === u.id)}
                        onChange={(e) => update.mutate({ id: u.id, input: { role: e.target.value as Role } }, { onSuccess: () => toast.success(`${u.name} is now ${e.target.value}`), onError: (err) => toast.error(errorMessage(err)) })}
                        options={ROLES.map((r) => ({ value: r, label: r }))}
                      />
                    </Tooltip>
                  </Td>
                  <Td muted>
                    <RelativeTime value={u.createdAt} />
                  </Td>
                  <Td muted>
                    <RelativeTime value={u.lastLoginAt} emptyText="never" />
                  </Td>
                  <Td align="right">
                    <Tooltip content={deleteBlocked ?? "Delete user"} side="left">
                      <Button size="icon-xs" variant="ghost" className="hover:text-danger" aria-label="Delete user" disabled={!!deleteBlocked} onClick={() => setDeleting(u)}>
                        <Trash2 />
                      </Button>
                    </Tooltip>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>

      <div className="mt-4 grid gap-2 text-xs text-fg-muted sm:grid-cols-3">
        {ROLES.map((r) => (
          <div key={r} className="card p-3">
            <Badge variant={r === "admin" ? "pro" : r === "operator" ? "info" : "neutral"} className="mb-1.5">
              {r}
            </Badge>
            <p>{ROLE_HELP[r]}</p>
          </div>
        ))}
      </div>

      <InviteDialog open={invite} onClose={() => setInvite(false)} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name}`}
        description={`${deleting?.email} loses access immediately. Their active sessions are revoked.`}
        confirmText="Delete user"
        danger
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id, { onSuccess: () => (setDeleting(null), toast.success("User deleted")), onError: (e) => toast.error(errorMessage(e)) })}
      />
    </Page>
  );
}

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateUser();
  const [form, setForm] = useState({ name: "", email: "", role: "viewer" as Role, password: generatePassword() });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    const parsed = createUserSchema.safeParse({ ...form, name: form.name.trim(), email: form.email.trim() });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0])] = i.message;
      setErrors(next);
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (u) => {
        toast.success(`${u.name} invited`, "Share the temporary password with them over a secure channel.");
        onClose();
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Invite user"
      description="There is no email delivery: copy the temporary password and share it yourself."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={create.isPending}>
            Create user
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input label="Name" autoFocus value={form.name} onChange={set("name")} error={errors.name} />
        <Input label="Email" type="email" value={form.email} onChange={set("email")} error={errors.email} />
        <Select label="Role" value={form.role} onChange={set("role")} options={ROLES.map((r) => ({ value: r, label: r }))} hint={ROLE_HELP[form.role]} />
        <div className="flex items-end gap-2">
          <Input label="Temporary password" mono value={form.password} onChange={set("password")} error={errors.password} wrapperClassName="flex-1" autoComplete="off" spellCheck={false} />
          <Button size="icon" variant="ghost" aria-label="Generate password" title="Generate" onClick={() => setForm((f) => ({ ...f, password: generatePassword() }))}>
            <RefreshCw />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
