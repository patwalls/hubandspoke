import { isNull, ne, or } from "drizzle-orm";
import { productionItems } from "@/lib/db/schema";

/**
 * Newsletters use the Scheduled status too (the email tool is told when to
 * send; newsletter-send-sweep.ts moves them), but they're never matched to a
 * live social post: the reconcile sweeps skip them, so no account sync, no
 * paid matcher call and no "needs attention" banner for an email.
 */
export const notNewsletter = or(isNull(productionItems.postType), ne(productionItems.postType, "newsletter"));
