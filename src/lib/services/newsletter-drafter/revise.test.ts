import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { templateFor } from "@/lib/newsletter-template";
import { planRevision, revisableKeys, revisionEdits, sectionInstruction } from "./revise";

const template = templateFor("Sunday Breakfast", null)!;

function fakeClient(input: unknown): { client: Anthropic; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    messages: {
      create: async (req: { messages: { content: string }[] }) => {
        prompts.push(req.messages[0].content);
        return { content: [{ type: "tool_use", id: "t", name: "submit_revision_plan", input }] };
      },
    },
  } as unknown as Anthropic;
  return { client, prompts };
}

describe("whole-email Revise plan", () => {
  it("never offers the sponsored section", () => {
    const sponsor = template.sections.find((s) => s.kind === "sponsor")!;
    expect(sponsor).toBeTruthy();
    expect(revisableKeys(template)).not.toContain(sponsor.key);
    expect(revisableKeys(template).length).toBeGreaterThan(1);
  });

  it("keeps one edit per known section, in template order, dropping unknown keys, the sponsor and blank instructions", () => {
    const keys = revisableKeys(template);
    const sponsor = template.sections.find((s) => s.kind === "sponsor")!.key;
    const [a, b] = keys;
    expect(
      revisionEdits(
        [
          { section_key: b, instruction: " cut the second paragraph " },
          { section_key: "made_up", instruction: "x" },
          { section_key: sponsor, instruction: "rewrite the ad" },
          { section_key: a, instruction: "   " },
          { section_key: b, instruction: "a duplicate" },
        ],
        keys,
      ),
    ).toEqual([{ sectionKey: b, instruction: "cut the second paragraph" }]);
  });

  it("gives each section its part plus the editor's whole note for context", () => {
    const out = sectionInstruction({ sectionKey: "intro", instruction: "Shorter." }, "  cut it by a third ");
    expect(out.startsWith("Shorter.")).toBe(true);
    expect(out).toContain('"cut it by a third"');
  });

  it("sends the note and the sections (not the ad) to the model and returns the filtered plan", async () => {
    const [first] = revisableKeys(template);
    const { client, prompts } = fakeClient({ edits: [{ section_key: first, instruction: "Mention the database is free." }, { section_key: "nope", instruction: "x" }] });
    const plan = await planRevision(
      { formatName: "Sunday Breakfast", note: "say the database is free", angle: null, template, sections: [{ key: first, markdown: "Hello there" }] },
      client,
    );
    expect(plan).toEqual({ ok: true, edits: [{ sectionKey: first, instruction: "Mention the database is free." }] });
    expect(prompts[0]).toContain("say the database is free");
    expect(prompts[0]).toContain("Hello there");
    expect(prompts[0]).not.toContain(`section_key: ${template.sections.find((s) => s.kind === "sponsor")!.key}`);
  });

  it("fails soft when the model returns no plan", async () => {
    const { client } = fakeClient({ wrong: true });
    const plan = await planRevision({ formatName: "Sunday Breakfast", note: "x", angle: null, template, sections: [] }, client);
    expect(plan).toEqual({ ok: false, failure: "llm-empty" });
  });
});
