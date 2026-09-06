import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Database, Info, KeyRound } from "lucide-react";
import { Page, PageHeader } from "@/components/layout/AppShell";
import { Tabs } from "@/components/ui/Tabs";
import { ConnectionsTab } from "./ConnectionsTab";
import { LicenseTab } from "./LicenseTab";
import { AboutTab } from "./AboutTab";

const TABS = ["connections", "license", "about"] as const;
type Tab = (typeof TABS)[number];

export function SettingsPage() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  if (!tab || !(TABS as readonly string[]).includes(tab)) return <Navigate to="/settings/connections" replace />;
  const current = tab as Tab;

  return (
    <Page>
      <PageHeader title="Settings" />
      <Tabs<Tab>
        aria-label="Settings sections"
        className="mb-5"
        value={current}
        onChange={(v) => navigate(`/settings/${v}`)}
        items={[
          { value: "connections", label: "Connections", icon: <Database className="size-3.5" /> },
          { value: "license", label: "License", icon: <KeyRound className="size-3.5" /> },
          { value: "about", label: "About", icon: <Info className="size-3.5" /> },
        ]}
      />
      {current === "connections" && <ConnectionsTab />}
      {current === "license" && <LicenseTab />}
      {current === "about" && <AboutTab />}
    </Page>
  );
}
