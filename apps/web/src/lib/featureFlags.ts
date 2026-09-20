/**
 * Build switches for work that exists but shouldn't show up yet.
 *
 * Flows stayed hidden for a while because the detected edges only cover
 * parent/child links of BullMQ flows: a queue that simply calls
 * `otherQueue.add()` doesn't show up, and that read as "broken" instead of
 * "not observable". The page solves this by letting the user draw the missing
 * edges by hand, and the on-screen copy explains the difference — so it's
 * back on. It's also what the license screen promises.
 */
export const SHOW_FLOWS = true;
