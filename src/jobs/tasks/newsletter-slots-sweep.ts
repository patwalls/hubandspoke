// Daily: keep the next 2 weeks of scheduled newsletter slots in place
// (Sunday Breakfast Sun, Daily Seinfeld Tue/Thu, Futurepedia How-To Tue),
// suggest How-To source videos, and re-check each idea slot's Asana sponsor
// so the Newsletters board shows "sponsor booked / missing" ahead of drafting.
// Idempotent (slot_key unique). Read-only on Asana. See docs/automation.md →
// newsletter-slots-sweep.
import type { Task } from "graphile-worker";
import { ensureSlots, refreshSlotSponsors } from "@/lib/services/newsletter-drafter/slots";

export const newsletterSlotsSweepTask: Task = async (_payload, helpers) => {
  const { created, suggested } = await ensureSlots();
  const sponsors = await refreshSlotSponsors();
  helpers.logger.info(`newsletter-slots-sweep: ${created} slots created, ${suggested} videos suggested, ${sponsors} sponsor checks`);
};
