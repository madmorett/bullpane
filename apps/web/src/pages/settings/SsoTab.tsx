import { useState } from "react";
import { Check, Copy, Plug, Plus, ShieldCheck, Trash2, TriangleAlert, X } from "lucide-react";
import {
  createSsoProviderSchema,
  type CreateSsoProviderInput,
  type SsoKind,
  type SsoProvider,
  type SsoTestResult,
} from "@bullpane/shared";
import {
  useCreateSsoProvider,
  useDeleteSsoProvider,
  useSetSsoSettings,
  useSsoProviders,
  useSsoSettings,
  useTestSsoProvider,
  useUpdateSsoProvider,
} from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useEdition } from "@/edition/useEdition";
import { LockedFeature } from "@/edition/LockedFeature";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select, Switch, Textarea } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const KIND_LABEL: Record<SsoKind, string> = { oidc: "OIDC", saml: "SAML 2.0" };

export function SsoTab() {
  const { has } = useEdition();
  if (!has("sso")) return <LockedFeature feature="sso" />;
  return <SsoManager />;
}

/** A value the admin has to paste into their IdP. Copyable, because they will. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-fg-subtle">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 text-[11px] text-fg-muted">{value}</code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => toast.error("Could not copy to the clipboard"),
          );
        }}
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </Button>
    </div>
  );
}

function SsoManager() {
  const providers = useSsoProviders();
  const settings = useSsoSettings();
  const setSettings = useSetSsoSettings();
  const update = useUpdateSsoProvider();
  const del = useDeleteSsoProvider();
  const test = useTestSsoProvider();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<SsoProvider | null>(null);
  const [results, setResults] = useState<Record<string, SsoTestResult>>({});

  const list = providers.data ?? [];
  const enabledCount = list.filter((p) => p.enabled).length;
  const requireSso = settings.data?.requireSso ?? false;

  const runTest = async (provider: SsoProvider) => {
    try {
      const result = await test.mutateAsync(provider.id);
      setResults((r) => ({ ...r, [provider.id]: result }));
    } catch (err) {
      setResults((r) => ({ ...r, [provider.id]: { ok: false, message: errorMessage(err) } }));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">Single sign-on</h2>
          <p className="mt-1 max-w-2xl text-xs text-fg-muted">
            Let your team sign in with your identity provider. Accounts are not created automatically: add the person under{" "}
            <span className="text-fg">Users &amp; roles</span> first, then they can sign in with SSO using that same email.
          </p>
        </div>
        <Button variant="primary" leftIcon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
          Add provider
        </Button>
      </div>

      {providers.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <div className="card p-6 text-center">
          <ShieldCheck className="mx-auto size-6 text-fg-subtle" />
          <p className="mt-2 text-sm text-fg">No identity provider yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-fg-muted">
            Add an OIDC provider (Google Workspace, Microsoft Entra ID, Okta, Keycloak, Authentik) or a SAML 2.0 provider.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((provider) => {
            const result = results[provider.id];
            return (
              <div key={provider.id} className="card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg">{provider.name}</span>
                      <Badge variant="neutral">{KIND_LABEL[provider.kind]}</Badge>
                      {!provider.enabled && <Badge variant="warning">disabled</Badge>}
                      {provider.kind === "oidc" && !provider.hasSecret && <Badge variant="danger">no client secret</Badge>}
                    </div>
                    <p className="mt-1 truncate text-xs text-fg-muted">
                      {provider.kind === "oidc"
                        ? String((provider.config as { issuer?: string }).issuer ?? "")
                        : String((provider.config as { entryPoint?: string }).entryPoint ?? "")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={provider.enabled}
                      label="Enabled"
                      onChange={(enabled) => {
                        update.mutate(
                          { id: provider.id, input: { enabled } },
                          { onError: (err) => toast.error(errorMessage(err)) },
                        );
                      }}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<Plug className="size-3.5" />}
                      loading={test.isPending && test.variables === provider.id}
                      onClick={() => void runTest(provider)}
                    >
                      Test
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="Delete provider" onClick={() => setDeleting(provider)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {/* The two values the admin must enter at the IdP. */}
                <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                  {provider.kind === "oidc" ? (
                    <CopyRow label="Redirect URI" value={provider.callbackUrl} />
                  ) : (
                    <>
                      <CopyRow label="ACS URL" value={provider.callbackUrl} />
                      {provider.entityId && <CopyRow label="Entity ID" value={provider.entityId} />}
                    </>
                  )}
                </div>

                {result && (
                  <div
                    className={`mt-3 rounded-md border px-3 py-2 text-xs ${
                      result.ok ? "border-success/40 bg-success/10 text-success" : "border-danger/40 bg-danger/10 text-danger"
                    }`}
                  >
                    <p className="flex items-center gap-1.5 font-medium">
                      {result.ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                      {result.message}
                    </p>
                    {result.details && (
                      <dl className="mt-2 space-y-0.5 text-fg-muted">
                        {Object.entries(result.details).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <dt className="w-44 shrink-0 font-mono text-[10px] uppercase">{k}</dt>
                            <dd className="min-w-0 truncate font-mono text-[10px]">{v}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* The lockout-shaped setting, with the escape hatch spelled out. */}
      <div className="card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-fg">Require SSO</p>
            <p className="mt-1 max-w-2xl text-xs text-fg-muted">
              Hide the password form and send everyone through your identity provider.{" "}
              <span className="text-fg">Admin accounts keep password sign-in</span> so a misconfigured provider cannot lock you out
              of your own installation. Set <code className="text-[11px]">BULLPANE_ALLOW_PASSWORD_LOGIN=true</code> to allow it for
              everyone.
            </p>
          </div>
          <Switch
            checked={requireSso}
            disabled={settings.isLoading || setSettings.isPending}
            onChange={(value) => {
              setSettings.mutate(
                { requireSso: value },
                {
                  onSuccess: () => toast.success(value ? "SSO is now required" : "Password sign-in is available again"),
                  onError: (err) => toast.error(errorMessage(err)),
                },
              );
            }}
          />
        </div>
        {requireSso && enabledCount === 0 && (
          <p className="mt-3 flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <TriangleAlert className="size-3.5 shrink-0" />
            SSO is required but no provider is enabled. Only admins can sign in right now.
          </p>
        )}
      </div>

      {adding && <AddProviderDialog onClose={() => setAdding(false)} />}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this provider?"
        confirmText="Delete"
        danger
        description={
          deleting
            ? `Anyone who signs in through "${deleting.name}" will have to use another method. The Bullpane accounts themselves are not touched.`
            : ""
        }
        loading={del.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          del.mutate(deleting.id, {
            onSuccess: () => {
              toast.success(`Deleted ${deleting.name}`);
              setDeleting(null);
            },
            onError: (err) => {
              toast.error(errorMessage(err));
              setDeleting(null);
            },
          });
        }}
      />
    </div>
  );
}

function AddProviderDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateSsoProvider();
  const [kind, setKind] = useState<SsoKind>("oidc");
  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [emailClaim, setEmailClaim] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [samlIssuer, setSamlIssuer] = useState("");
  const [idpCert, setIdpCert] = useState("");
  const [emailAttribute, setEmailAttribute] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const input: CreateSsoProviderInput =
      kind === "oidc"
        ? {
            kind: "oidc",
            name: name.trim(),
            config: {
              issuer: issuer.trim(),
              clientId: clientId.trim(),
              clientSecret,
              ...(emailClaim.trim() ? { emailClaim: emailClaim.trim() } : {}),
            },
          }
        : {
            kind: "saml",
            name: name.trim(),
            config: {
              entryPoint: entryPoint.trim(),
              issuer: samlIssuer.trim(),
              idpCert: idpCert.trim(),
              ...(emailAttribute.trim() ? { emailAttribute: emailAttribute.trim() } : {}),
            },
          };

    // Validate with the same schema the server uses, so the error is the same too.
    const parsed = createSsoProviderSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the fields above");
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (provider) => {
        toast.success(`Added ${provider.name}. Enter the redirect URI at your IdP, then use Test.`);
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add an identity provider"
      description="Bullpane never creates accounts from SSO — invite people under Users & roles first."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Add provider
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Select label="Protocol" value={kind} onChange={(e) => setKind(e.target.value as SsoKind)}>
          <option value="oidc">OIDC / OpenID Connect</option>
          <option value="saml">SAML 2.0</option>
        </Select>
        <Input
          label="Display name"
          placeholder={kind === "oidc" ? "Google Workspace" : "Corporate SSO"}
          hint="Shown on the sign-in button."
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />

        {kind === "oidc" ? (
          <>
            <Input
              label="Issuer URL"
              placeholder="https://accounts.google.com"
              hint="Endpoints are discovered from /.well-known/openid-configuration, so this is the only URL you need."
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              required
            />
            <Input label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
            <Input
              label="Client secret"
              type="password"
              hint="Stored encrypted and never shown again."
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              required
            />
            <Input
              label="Email claim (optional)"
              placeholder="email"
              hint="Override only if your provider puts the email somewhere else, e.g. upn."
              value={emailClaim}
              onChange={(e) => setEmailClaim(e.target.value)}
            />
          </>
        ) : (
          <>
            <Input
              label="Sign-in URL (SSO endpoint)"
              placeholder="https://idp.example.com/sso/saml"
              value={entryPoint}
              onChange={(e) => setEntryPoint(e.target.value)}
              required
            />
            <Input
              label="IdP entity ID"
              placeholder="https://idp.example.com/metadata"
              value={samlIssuer}
              onChange={(e) => setSamlIssuer(e.target.value)}
              required
            />
            <Textarea
              label="IdP signing certificate"
              rows={5}
              placeholder="-----BEGIN CERTIFICATE-----"
              hint="PEM or base64. Assertions must be signed; there is no way to disable that."
              value={idpCert}
              onChange={(e) => setIdpCert(e.target.value)}
              required
            />
            <Input
              label="Email attribute (optional)"
              placeholder="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
              value={emailAttribute}
              onChange={(e) => setEmailAttribute(e.target.value)}
            />
          </>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
