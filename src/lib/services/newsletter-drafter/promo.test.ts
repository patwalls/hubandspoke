import { describe, expect, it } from "vitest";
import { PROMO_TASK_NOTES } from "@/test/asana-fixtures";
import { extractSpecial, pickPromoTask, promoCalendarFor } from "./promo";
import { SPECIAL_MARKER, adLink, composeBody, composeSpecialBlock, withAdLink } from "./special-compose";

const task = (gid: string, due: string | null, section: string) => ({
  gid,
  name: gid,
  due_on: due,
  memberships: [{ section: { name: section } }],
});

describe("promo calendar lookup", () => {
  it("only Sunday Breakfast has a promo calendar", () => {
    expect(promoCalendarFor(" Sunday Breakfast ")?.section).toBe("Native Ad");
    expect(promoCalendarFor("Daily Seinfeld")).toBeNull();
  });

  it("picks the task due on the send date in the promo section, not other sections", () => {
    const tasks = [task("blast", "2026-10-25", "Marketing Blast"), task("ad", "2026-10-25", "Native Ad"), task("next", "2026-11-01", "Native Ad")];
    expect(pickPromoTask(tasks, "2026-10-25", "Native Ad")?.gid).toBe("ad");
    expect(pickPromoTask(tasks, "2026-10-18", "Native Ad")).toBeNull();
  });

  it("prefers a 'Final Newsletter Copy' subtask over the form's focus answer", () => {
    const fromSubtask = extractSpecial(PROMO_TASK_NOTES, [{ gid: "1", name: "final newsletter copy", notes: "Real copy here." }]);
    expect(fromSubtask).toMatchObject({ copy: "Real copy here.", copyFrom: "subtask" });
    expect(fromSubtask?.landingUrl).toContain("ai-crm-lp");

    const placeholder = extractSpecial(PROMO_TASK_NOTES, [{ gid: "2", name: "Final Newsletter Copy", notes: "  " }]);
    expect(placeholder).toMatchObject({ copy: "Downmarket Revival", copyFrom: "focus_field" });
  });

  it("returns null when the task has neither copy source", () => {
    expect(extractSpecial("Name:\nSomeone", [])).toBeNull();
  });
});

describe("composing The Special into the body", () => {
  const url = "https://www.hubspot.com/lp";

  it("adds a CTA link only when the copy doesn't already carry the landing URL", () => {
    expect(composeSpecialBlock("Pitch.", url)).toBe(`Pitch.\n\n**[Check it out HERE](${url})**`);
    expect(composeSpecialBlock(`Pitch. [Go](${url})`, url)).toBe(`Pitch. [Go](${url})`);
    expect(composeSpecialBlock("Pitch.", null)).toBe("Pitch.");
  });

  it("replaces the marker, and leaves the body alone when there's no copy", () => {
    const body = `## The Special 🍽️\n\n${SPECIAL_MARKER}\n\n## The Eggs 🍳`;
    expect(composeBody(body, { copy: "Pitch.", landingUrl: null })).toBe("## The Special 🍽️\n\nPitch.\n\n## The Eggs 🍳");
    expect(composeBody(body, { copy: null, landingUrl: url })).toBe(body);
    expect(composeBody(body, null)).toBe(body);
  });
});

describe("the ad's main link", () => {
  it("is the button line when there is one, else the last link, else the last bare URL", () => {
    expect(adLink("Try [it](https://a.example) today.\n\n**[Check it out HERE](https://b.example/x?utm=1)**")).toBe("https://b.example/x?utm=1");
    expect(adLink("Try [it](https://a.example) or [this](https://c.example).")).toBe("https://c.example");
    expect(adLink("Go to https://d.example/page now.")).toBe("https://d.example/page");
    expect(adLink("No link here.")).toBeNull();
  });

  it("swaps every copy of the main link, or adds a CTA line when there's none", () => {
    expect(withAdLink("[Try](https://old.example) and **[Go](https://old.example)**", "https://new.example")).toBe("[Try](https://new.example) and **[Go](https://new.example)**");
    expect(withAdLink("Just copy.", "https://new.example")).toBe("Just copy.\n\n**[Check it out HERE](https://new.example)**");
  });
});
