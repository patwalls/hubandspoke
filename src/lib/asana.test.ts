import { describe, expect, it } from "vitest";
import { PROMO_TASK_NOTES as NOTES } from "@/test/asana-fixtures";
import { parseAsanaFormNotes } from "./asana";

describe("parseAsanaFormNotes", () => {
  it("maps each form question to its answer and drops the submission footer", () => {
    const form = parseAsanaFormNotes(NOTES);
    expect(form["What should we focus on in the ad copy?"]).toBe("Downmarket Revival");
    expect(form["Which landing page URL should we use?"]).toBe(
      "https://www.hubspot.com/products/crm/ai-crm-lp?utm_source=starter-story&utm_term=2026-10-25",
    );
    expect(form["What is the Content type"]).toBe("HubSpot Campaign");
    expect(Object.values(form).some((v) => v.includes("form.asana.com"))).toBe(false);
  });

  it("keeps multi-line answers together", () => {
    expect(parseAsanaFormNotes("Anything else?:\nline one\nline two")["Anything else?"]).toBe("line one\nline two");
  });
});
