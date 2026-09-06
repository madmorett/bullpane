/**
 * Build-time feature switches for work that exists but is not ready to show.
 *
 * Flows is complete and tested, but hidden for now: detected edges only cover
 * BullMQ flow parent/child links, so a queue that simply calls `otherQueue.add()`
 * shows nothing, which reads as "broken" rather than "not observable". Set this
 * back to true to bring the nav entry, the routes and the Pro upsell back.
 *
 * Hiding it here (rather than deleting) keeps the page, its API hooks and the
 * server routes intact, so re-enabling is a one-line change.
 */
export const SHOW_FLOWS = false;
