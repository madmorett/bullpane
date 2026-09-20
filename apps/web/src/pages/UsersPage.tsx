import { useState } from "react";
import { RefreshCw, UserCheck, UserPlus, UserX } from "lucide-react";
import { ROLES, createUserSchema, type Role, type User } from "@bullpane/shared";
import { useCreateUser, useUpdateUser, useUsers } from "@/api/hooks";
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
import { Input, Select, Switch } from "@/components/ui/Input";
import { Table, TableMessage, Td, Th } from "@/components/ui/Table";
import { cn } from "@/lib/cn";
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
  const [invite, setInvite] = useState(false);
  const [disabling, setDisabling] = useState<User | null>(null);

  // Active people first, disabled ones at the bottom: the list is for finding
  // who can get in today, and a disabled row is history until re-enabled.
  const list = [...(users.data ?? [])].sort((a, b) => Number(!!a.disabledAt) - Number(!!b.disabledAt) || a.name.localeCompare(b.name));
  // Only active admins count: a disabled admin cannot log in to fix anything.
  const admins = list.filter((u) => u.role === "admin" && !u.disabledAt).length;

  const setDisabled = (u: User, disabled: boolean) =>
    update.mutate(
      { id: u.id, input: { disabled } },
      {
        onSuccess: () => {
          setDisabling(null);
          toast.success(disabled ? `${u.name} disabled` : `${u.name} re-enabled`, disabled ? "Their sessions are revoked; the account keeps its history." : "They can sign in again.");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

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
              const disabled = !!u.disabledAt;
              const lastAdmin = u.role === "admin" && !disabled && admins <= 1;
              const disableBlocked = isMe ? "You cannot disable your own account" : lastAdmin ? "Cannot disable the last admin" : null;
              const busy = update.isPending && update.variables?.id === u.id;
              return (
                <tr key={u.id} className={cn(disabled && "text-fg-muted")}>
                  <Td className="font-medium">
                    <span className={cn(disabled && "line-through decoration-fg-subtle")}>{u.name}</span>
                    {isMe && (
                      <Badge variant="outline" size="xs" className="ml-1.5">
                        you
                      </Badge>
                    )}
                    {disabled && (
                      <Tooltip content={<>Disabled <RelativeTime value={u.disabledAt} withAbsolute />. Cannot sign in; sessions revoked.</>} side="bottom">
                        <Badge variant="neutral" size="xs" className="ml-1.5">
                          disabled
                        </Badge>
                      </Tooltip>
                    )}
                  </Td>
                  <Td muted>{u.email}</Td>
                  <Td>
                    <Tooltip content={isMe ? "Ask another admin to change your role" : lastAdmin ? "Promote someone else to admin first" : ROLE_HELP[u.role]} block>
                      <Select
                        aria-label={`Role of ${u.name}`}
                        className="!h-7 text-xs"
                        value={u.role}
                        disabled={isMe || lastAdmin || disabled || busy}
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
                    {disabled ? (
                      <Tooltip content="Re-enable: they can sign in again with the same account" side="left">
                        <Button size="xs" variant="ghost" leftIcon={<UserCheck />} aria-label={`Re-enable ${u.name}`} loading={busy} onClick={() => setDisabled(u, false)}>
                          Enable
                        </Button>
                      </Tooltip>
                    ) : (
                      <Tooltip content={disableBlocked ?? "Disable: revokes access, keeps the account and its history"} side="left">
                        <Button size="icon-xs" variant="ghost" className="hover:text-danger" aria-label={`Disable ${u.name}`} disabled={!!disableBlocked || busy} onClick={() => setDisabling(u)}>
                          <UserX />
                        </Button>
                      </Tooltip>
                    )}
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
        open={!!disabling}
        onClose={() => setDisabling(null)}
        title={`Disable ${disabling?.name}`}
        description={`${disabling?.email} loses access immediately: active sessions are revoked and password or SSO sign-in is refused. The account and its audit history stay, and you can re-enable it any time.`}
        confirmText="Disable user"
        danger
        loading={update.isPending}
        onConfirm={() => disabling && setDisabled(disabling, true)}
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
  const { has } = useEdition();
  const ssoAvailable = has("sso");
  const [form, setForm] = useState({ name: "", email: "", role: "viewer" as Role, password: generatePassword() });
  /**
   * With SSO configured, a temporary password for somebody who will only ever
   * click "Sign in with ..." is a credential nobody rotates. An SSO-only
   * account has no password hash at all, so it CANNOT use the password form —
   * not even through the admin escape hatch.
   */
  const [ssoOnly, setSsoOnly] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    const payload = {
      name: form.name.trim(),
      email: form.email.trim(),
      role: form.role,
      ...(ssoOnly ? {} : { password: form.password }),
    };
    const parsed = createUserSchema.safeParse(payload);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0])] = i.message;
      setErrors(next);
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (u) => {
        toast.success(
          `${u.name} invited`,
          ssoOnly ? "They can now sign in with SSO using that email." : "Share the temporary password with them over a secure channel.",
        );
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
      description={
        ssoOnly
          ? "The account is created without a password; they sign in through your identity provider."
          : "There is no email delivery: copy the temporary password and share it yourself."
      }
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
        {ssoAvailable && (
          <div className="flex items-center gap-2.5">
            <Switch checked={ssoOnly} onChange={setSsoOnly} label="SSO only (no password)" />
            <button type="button" className="text-xs font-medium text-fg" onClick={() => setSsoOnly(!ssoOnly)}>
              SSO only (no password)
            </button>
          </div>
        )}
        {ssoOnly ? (
          <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-fg-muted">
            This account will have no password and can only sign in through an identity provider. Make sure the email matches the one
            your IdP sends.
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <Input label="Temporary password" mono value={form.password} onChange={set("password")} error={errors.password} wrapperClassName="flex-1" autoComplete="off" spellCheck={false} />
            <Button size="icon" variant="ghost" aria-label="Generate password" title="Generate" onClick={() => setForm((f) => ({ ...f, password: generatePassword() }))}>
              <RefreshCw />
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
