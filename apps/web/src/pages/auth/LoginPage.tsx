import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { loginSchema } from "@bullpane/shared";
import { errorMessage, isApiError } from "@/api/client";
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);

  if (needsSetup) return <Navigate to="/setup" replace />;

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
      const from = location.state?.from;
      navigate(from?.pathname ? `${from.pathname}${from.search ?? ""}` : "/", { replace: true });
    } catch (err) {
      if (isApiError(err) && err.status === 401) setError("Invalid email or password");
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      description={demo ? "Demo playground: Pro features are unlocked, settings are read-only." : "Use the account created during setup."}
      footer={
        <>
          Self-hosted dashboard for BullMQ ·{" "}
          <Link to="/setup" className="hover:text-fg">
            first run?
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <Input
          label="Email"
          type="email"
          autoComplete="username"
          autoFocus
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
        {error && (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
