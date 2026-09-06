import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Page } from "@/components/layout/AppShell";

export function NotFoundPage() {
  return (
    <Page>
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        description="The link may be stale, or the queue or connection was removed."
        action={
          <Link to="/" className="text-accent hover:underline">
            Back to overview
          </Link>
        }
      />
    </Page>
  );
}
