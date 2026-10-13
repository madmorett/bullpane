import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Tabs } from "@/components/ui/Tabs";
import { getThemePref, setThemePref, type ThemePref } from "@/lib/theme";

export function AppearanceTab() {
  const [pref, setPref] = useState(getThemePref);

  return (
    <div className="card max-w-xl p-4">
      <h2 className="text-sm font-semibold">Theme</h2>
      <p className="mt-1 mb-3 text-xs text-fg-muted">Saved in this browser only. System follows your OS setting.</p>
      <Tabs<ThemePref>
        aria-label="Theme"
        variant="pills"
        className="w-fit"
        value={pref}
        onChange={(v) => {
          setThemePref(v);
          setPref(v);
        }}
        items={[
          { value: "system", label: "System", icon: <Monitor className="size-3.5" /> },
          { value: "light", label: "Light", icon: <Sun className="size-3.5" /> },
          { value: "dark", label: "Dark", icon: <Moon className="size-3.5" /> },
        ]}
      />
    </div>
  );
}
