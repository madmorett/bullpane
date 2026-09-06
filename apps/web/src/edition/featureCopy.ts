import type { ProFeature } from "@bullmq-visualizer/shared";

export interface FeatureCopy {
  title: string;
  tagline: string;
  bullets: [string, string, string];
}

export const FEATURE_COPY: Record<ProFeature, FeatureCopy> = {
  alerts: {
    title: "Alerts",
    tagline: "Know before your users do. Slack or webhook, evaluated server-side every few seconds.",
    bullets: [
      "Waiting above N, failures in a window, failure-rate %, connection down",
      "Scope to one queue, a whole connection, or everything",
      "Cooldown per alert and an events feed with delivery status",
    ],
  },
  users: {
    title: "Users & roles",
    tagline: "Give the whole team a login without giving everyone the obliterate button.",
    bullets: [
      "Admin, operator and viewer roles enforced on every endpoint",
      "Invite by email with a temporary password",
      "Last-login audit and safe deletion guards",
    ],
  },
  folders: {
    title: "Folders",
    tagline: "Organise hundreds of queues across connections the way your teams think about them.",
    bullets: [
      "Nested folders with colours, shown in the sidebar",
      "Assign queues from any connection with a picker",
      "The default stays one folder per connection, so nothing breaks",
    ],
  },
  flows: {
    title: "Flows",
    tagline: "See how queues feed each other, detected from BullMQ flow parents plus your own edges.",
    bullets: [
      "Edges detected from job parent references with evidence counts",
      "Manual edges for producer → consumer relationships Redis cannot see",
      "Auto-layout graph with live counts and paused state per queue",
    ],
  },
};

export const FEATURE_ROUTE: Record<ProFeature, string> = {
  alerts: "/alerts",
  users: "/users",
  folders: "/folders",
  flows: "/flows",
};
