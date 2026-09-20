import { useEffect, useState } from "react";
import { DEFAULT_ATTENTION_THRESHOLDS, attentionThresholdsSchema } from "@bullpane/shared";
import { useAttentionThresholds, useUpdateAttentionThresholds } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";

/**
 * The two numbers behind the Overview's "Needs attention" section.
 *
 * Free, not Pro: without them the section is hard-coded and wrong for anyone
 * whose queues do not look like the defaults, which is most people. Alerts stay
 * the Pro feature — these change what a page shows, not what gets notified.
 */
export function AttentionTab() {
  const { isAdmin } = useAuth();
  const query = useAttentionThresholds();
  const save = useUpdateAttentionThresholds();

  // Text, not number: an empty box during editing is a valid intermediate state
  // and `<input type=number>` reports it as NaN, which would fight the user.
  const [waiting, setWaiting] = useState("");
  const [failed, setFailed] = useState("");

  const loaded = query.data;
  useEffect(() => {
    if (!loaded) return;
    setWaiting(String(loaded.waitingAbove));
    setFailed(String(loaded.failedAbove));
  }, [loaded]);

  if (query.isLoading) return <Spinner />;

  const parsed = attentionThresholdsSchema.safeParse({
    waitingAbove: Number(waiting === "" ? 0 : waiting),
    failedAbove: Number(failed === "" ? 0 : failed),
  });
  const dirty =
    !!loaded && parsed.success && (parsed.data.waitingAbove !== loaded.waitingAbove || parsed.data.failedAbove !== loaded.failedAbove);

  const onSave = () => {
    if (!parsed.success) return;
    save.mutate(parsed.data, {
      onSuccess: () => toast.success("Attention thresholds saved"),
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <div className="max-w-xl space-y-5">
      <p className="text-xs text-fg-muted">
        When a queue shows up in <strong className="font-medium text-fg">Needs attention</strong> at the top of the Overview.
        Failing, paused and stuck-with-no-worker queues are always flagged — these two add the cases only you can define.
        <span className="text-fg-subtle"> Set 0 to turn a rule off.</span>
      </p>

      <Input
        label="Waiting above"
        hint="Flag a queue whose waiting backlog passes this, even when a worker is draining it. Leave at 0 if your queues run deep on purpose."
        inputMode="numeric"
        value={waiting}
        disabled={!isAdmin}
        onChange={(e) => setWaiting(e.target.value.replace(/[^0-9]/g, ""))}
      />

      <Input
        label="Failed above"
        hint="Flag a queue whose failed list passes this. At 0 any failed job at all is flagged, which is the previous behaviour."
        inputMode="numeric"
        value={failed}
        disabled={!isAdmin}
        onChange={(e) => setFailed(e.target.value.replace(/[^0-9]/g, ""))}
      />

      {isAdmin ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={!dirty || save.isPending} onClick={onSave}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setWaiting(String(loaded?.waitingAbove ?? DEFAULT_ATTENTION_THRESHOLDS.waitingAbove));
                setFailed(String(loaded?.failedAbove ?? DEFAULT_ATTENTION_THRESHOLDS.failedAbove));
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-fg-subtle">Only an administrator can change these.</p>
      )}
    </div>
  );
}
