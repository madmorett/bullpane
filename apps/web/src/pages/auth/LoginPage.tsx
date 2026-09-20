import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { KeyRound, ShieldCheck } from "lucide-react";
import { loginSchema } from "@bullpane/shared";
import { errorMessage, isApiError } from "@/api/client";
import { useSsoLoginOptions } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AuthLayout } from "./AuthLayout";

export function LoginPage() {
  const { login, needsSetup } = useAuth();
  const { demo } = useEdition();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string; search?: string } } };
  const [searchParams, setSearchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);

  /**
   * The SSO flow cannot render a React error: it is a browser redirect. So the
   * callback bounces back here with ?sso_error=<one sentence> and the page owns
   * showing it.
   */
  const ssoError = searchParams.get("sso_error");
  useEffect(() => {
    if (!ssoError) return;
    setError(ssoError);
    // Consume it, so a refresh does not re-show a stale failure.
    const next = new URLSearchParams(searchParams);
    next.delete("sso_error");
    setSearchParams(next, { replace: true });
  }, [ssoError, searchParams, setSearchParams]);

  const { data: sso } = useSsoLoginOptions();
  const providers = sso?.providers ?? [];
  const hasSso = providers.length > 0;
  /**
   * With "require SSO" on, the password form is hidden — but never removed:
   * admins keep it (passwordEscapeHatch), because a misconfigured IdP on a
   * self-hosted install has nobody to call. The link below reveals it.
   */
  const requireSso = sso?.requireSso ?? false;
  const [showPassword, setShowPassword] = useState(false);
  const passwordVisible = !requireSso || showPassword;

  if (needsSetup) return <Navigate to="/setup" replace />;

  const from = location.state?.from;
  const nextPath = from?.pathname ? `${from.pathname}${from.search ?? ""}` : undefined;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = loginSchema.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      const fe: typeof fieldErrors = {};
      for (const issue of parsed.error.issues) fe[issue.path[0] as keyof typeof fe] = issue.message;
      setFieldErrors(fe);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      await login(parsed.data);
      navigate(nextPath ?? "/", { replace: true });
    } catch (err) {
      if (isApiError(err) && err.status === 401) setError(errorMessage(err, "Invalid email or password"));
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      description={
        demo
          ? "Demo playground: Pro features are unlocked, settings are read-only."
          : requireSso
            ? "This installation signs in through your identity provider."
            : "Use the account created during setup."
      }
      footer={
        <>
          Self-hosted dashboard for BullMQ ·{" "}
          <Link to="/setup" className="hover:text-fg">
            first run?
          </Link>
        </>
      }
    >
      {error && (
        <p role="alert" className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      {hasSso && (
        <div className="space-y-2">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              variant="secondary"
              className="w-full"
              leftIcon={<ShieldCheck className="size-4" />}
              /**
               * A full page navigation, not fetch(): the whole point is to hand
               * the browser to the IdP. `next` is preserved so a deep link the
               * user was refused survives the round trip.
               */
              onClick={() => {
                const url = `/api/auth/sso/${encodeURIComponent(provider.id)}/start`;
                window.location.href = nextPath ? `${url}?next=${encodeURIComponent(nextPath)}` : url;
              }}
            >
              Sign in with {provider.name}
            </Button>
          ))}
        </div>
      )}

      {hasSso && passwordVisible && (
        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[11px] uppercase tracking-wide text-fg-subtle">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}

      {passwordVisible ? (
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <Input
            label="Email"
            type="email"
            autoComplete="username"
            autoFocus={!hasSso}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldErrors.email}
            required
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldErrors.password}
            required
          />
          {requireSso && (
            <p className="text-[11px] text-fg-subtle">
              {sso?.passwordEscapeHatch === "all"
                ? "Password sign-in is allowed for everyone on this installation (BULLPANE_ALLOW_PASSWORD_LOGIN)."
                : "Password sign-in works for admin accounts only, so a misconfigured provider cannot lock you out."}
            </p>
          )}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Sign in
          </Button>
        </form>
      ) : (
        <div className="mt-4 text-center">
          <Button variant="link" size="sm" leftIcon={<KeyRound className="size-3.5" />} onClick={() => setShowPassword(true)}>
            Sign in with a password instead
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
