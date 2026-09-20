import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { setupSchema } from "@bullpane/shared";
import { errorMessage, isApiError } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AuthLayout } from "./AuthLayout";

export function SetupPage() {
  const { setup, needsSetup, loading } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && !needsSetup) return <Navigate to="/login" replace />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = setupSchema.safeParse({ name: form.name.trim(), email: form.email.trim(), password: form.password });
    const fe: Record<string, string> = {};
    if (!parsed.success) for (const issue of parsed.error.issues) fe[String(issue.path[0])] = issue.message;
    if (form.password !== form.confirm) fe.confirm = "Passwords do not match";
    setErrors(fe);
    if (Object.keys(fe).length > 0 || !parsed.success) return;
    setBusy(true);
    try {
      await setup(parsed.data);
      navigate("/", { replace: true });
    } catch (err) {
      if (isApiError(err) && err.status === 409) setError("Setup was already completed. Sign in instead.");
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Create the admin account" description="This is the first run. The account you create here is the administrator of this installation.">
      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <Input label="Name" autoFocus autoComplete="name" value={form.name} onChange={set("name")} error={errors.name} required />
        <Input label="Email" type="email" autoComplete="username" value={form.email} onChange={set("email")} error={errors.email} required />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={set("password")}
          error={errors.password}
          hint="At least 8 characters"
          required
        />
        <Input label="Confirm password" type="password" autoComplete="new-password" value={form.confirm} onChange={set("confirm")} error={errors.confirm} required />
        {error && (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
