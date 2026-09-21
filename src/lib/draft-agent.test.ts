import { describe, expect, it } from "vitest";
import {
  findEmptyRequiredFields,
  renderClipIdeaExtras,
  renderEditorialContextBlock,
  type EditorialContext,
} from "./draft-agent";
import type { FormatFieldSchema } from "@/lib/db/schema";

// Mirrors the youtube_community schema shape — body is required, cta is
// optional. The original bug: agent returned `body: ""` and the draft
// landed in the DB with the placeholder.
const YT_COMMUNITY_SCHEMA: FormatFieldSchema = {
  version: 3,
  fields: [
    {
      key: "body",
      label: "Post body",
      type: "longtext",
      maxLength: 2000,
      required: true,
      prompt: "YouTube Community post body. Open with a single concrete hook.",
    },
    {
      key: "cta",
      label: "Pinned comment",
      type: "longtext",
      maxLength: 10000,
      required: false,
      prompt: "Pinned comment CTA.",
    },
  ],
};

describe("findEmptyRequiredFields", () => {
  it("returns empty list when all required fields are non-empty", () => {
    expect(
      findEmptyRequiredFields(
        { body: "Who's getting their 2 hours in?", cta: "" },
        YT_COMMUNITY_SCHEMA,
      ),
    ).toEqual([]);
  });

  it("flags an empty required string field — the YouTube Community failure", () => {
    expect(
      findEmptyRequiredFields({ body: "", cta: "something" }, YT_COMMUNITY_SCHEMA),
    ).toEqual(["body"]);
  });

  it("flags a whitespace-only required field as empty", () => {
    // The agent occasionally returns "  \n  " when it gives up — that's
    // the same failure mode as "" for the user. normalizeContent already
    // trims, so this just confirms the trim is in place.
    expect(
      findEmptyRequiredFields({ body: "  \n  " }, YT_COMMUNITY_SCHEMA),
    ).toEqual(["body"]);
  });

  it("flags a missing required field as empty", () => {
    expect(
      findEmptyRequiredFields({ cta: "x" }, YT_COMMUNITY_SCHEMA),
    ).toEqual(["body"]);
  });

  it("does not flag empty optional fields", () => {
    // cta is optional — empty cta should never trigger the retry, even
    // though the CTA BASELINE TEMPLATE in the system prompt says to
    // always fill it. The retry-on-empty is specifically scoped to
    // required:true fields to avoid loops on CTA-shy drafts.
    expect(
      findEmptyRequiredFields({ body: "hi", cta: "" }, YT_COMMUNITY_SCHEMA),
    ).toEqual([]);
  });

  it("flags an empty required tags array", () => {
    const schema: FormatFieldSchema = {
      version: 3,
      fields: [
        {
          key: "tags",
          label: "Tags",
          type: "tags",
          required: true,
          prompt: "Up to 5 hashtags.",
        },
      ],
    };
    expect(findEmptyRequiredFields({ tags: [] }, schema)).toEqual(["tags"]);
  });

  it("returns empty list when the propose_draft input isn't an object", () => {
    // Defensive — the agent's tool input is `unknown` from the SDK and
    // could theoretically be null/undefined/array. We don't want the
    // validator to crash; it should fall through to the empty-required
    // list (which trips the retry, which would then fail the second
    // strike). Better than a stack trace from the type-narrow.
    expect(findEmptyRequiredFields(null, YT_COMMUNITY_SCHEMA)).toEqual(["body"]);
    expect(findEmptyRequiredFields("nonsense", YT_COMMUNITY_SCHEMA)).toEqual([
      "body",
    ]);
  });
});

const EMPTY_EC: EditorialContext = {
  itemHook: null,
  itemOverlay: null,
  itemCoverDescription: null,
  clipIdea: null,
  pillar: null,
};

describe("renderEditorialContextBlock (v14)", () => {
  it("returns null when the context is missing entirely", () => {
    expect(renderEditorialContextBlock(null)).toBeNull();
    expect(renderEditorialContextBlock(undefined)).toBeNull();
  });

  it("returns null when every field is null/blank", () => {
    expect(renderEditorialContextBlock(EMPTY_EC)).toBeNull();
    // Whitespace-only fields are treated as blank too.
    expect(
      renderEditorialContextBlock({
        ...EMPTY_EC,
        itemHook: "   ",
        clipIdea: {
          hook: "",
          angle: "  \n",
          rationale: null,
          anchorQuote: null,
          anchorStartSec: null,
          blueprintAnchorHook: null,
        },
      }),
    ).toBeNull();
  });

  it("renders the item hook with the operator-edit primacy label", () => {
    const out = renderEditorialContextBlock({
      ...EMPTY_EC,
      itemHook: "He shipped 300 features and 6 apps in 3 months. Same boring setup every time:",
    });
    expect(out).not.toBeNull();
    expect(out).toMatch(/## EDITORIAL CONTEXT/);
    expect(out).toMatch(/operator's most recent edit/i);
    expect(out).toContain("He shipped 300 features and 6 apps in 3 months");
  });

  it("item hook wins over clipIdea hook when both are present", () => {
    const out = renderEditorialContextBlock({
      ...EMPTY_EC,
      itemHook: "Operator's edited hook",
      clipIdea: {
        hook: "Original clip-idea hook",
        angle: null,
        rationale: null,
        anchorQuote: null,
        anchorStartSec: null,
        blueprintAnchorHook: null,
      },
    });
    expect(out).toContain("Operator's edited hook");
    // The "fallback to clip-idea hook" branch must NOT fire when itemHook
    // is present — that block would render "no operator override yet".
    expect(out).not.toMatch(/no operator override yet/);
  });

  it("falls back to clipIdea.hook when itemHook is missing", () => {
    const out = renderEditorialContextBlock({
      ...EMPTY_EC,
      itemHook: null,
      clipIdea: {
        hook: "Original clip-idea hook",
        angle: null,
        rationale: null,
        anchorQuote: null,
        anchorStartSec: null,
        blueprintAnchorHook: null,
      },
    });
    expect(out).toMatch(/no operator override yet/);
    expect(out).toContain("Original clip-idea hook");
  });

  it("formats the anchor timestamp as MM:SS", () => {
    const out = renderEditorialContextBlock({
      ...EMPTY_EC,
      clipIdea: {
        hook: null,
        angle: null,
        rationale: null,
        anchorQuote: "I made three TikTok accounts and posted three times a day",
        anchorStartSec: 327.42,
        blueprintAnchorHook: null,
      },
    });
    expect(out).toContain('"I made three TikTok accounts and posted three times a day" @ 5:27');
  });

  it("omits the anchor timestamp when anchorStartSec is null", () => {
    const out = renderEditorialContextBlock({
      ...EMPTY_EC,
      clipIdea: {
        hook: null,
        angle: null,
        rationale: null,
        anchorQuote: "some quote",
        anchorStartSec: null,
        blueprintAnchorHook: null,
      },
    });
    expect(out).toContain('"some quote"');
    expect(out).not.toContain(" @ ");
  });

  it("truncates pillar.description over 500 chars", () => {
    const longDesc = "A".repeat(800);
    const out = renderEditorialContextBlock({
      ...EMPTY_EC,
      pillar: {
        title: null,
        hook: null,
        description: longDesc,
        overlay: null,
      },
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(longDesc.length + 200);
    expect(out).toMatch(/A{500}…/);
  });

  it("renders all sections together for a fully-populated item", () => {
    const out = renderEditorialContextBlock({
      itemHook: "Hook line",
      itemOverlay: "BURN-IN TEXT",
      itemCoverDescription: "Cover description",
      clipIdea: {
        hook: "Clip hook",
        angle: "The angle",
        rationale: "Why this works",
        anchorQuote: "the verbatim line",
        anchorStartSec: 65,
        blueprintAnchorHook: "Reference library hook",
      },
      pillar: {
        title: "Pillar title",
        hook: "Pillar hook",
        description: "Pillar description",
        overlay: "Pillar overlay",
      },
    });
    expect(out).toContain("Hook line");
    expect(out).toContain("The angle");
    expect(out).toContain("the verbatim line");
    expect(out).toContain("Why this works");
    expect(out).toContain("BURN-IN TEXT");
    expect(out).toContain("Cover description");
    expect(out).toContain("Pillar title");
    expect(out).toContain("Pillar hook");
    expect(out).toContain("Pillar description");
  });
});

describe("renderEditorialContextBlock (v15: the clip itself)", () => {
  const clipIdea = {
    hook: null,
    angle: null,
    rationale: null,
    anchorQuote: null,
    anchorStartSec: null,
    blueprintAnchorHook: null,
  };

  it("renders the cut's words with its range and edited length, and the idea's extras as a list", () => {
    const out = renderEditorialContextBlock({
      ...EMPTY_EC,
      clipIdea: {
        ...clipIdea,
        clip: { startSec: 754, endSec: 781.4, durationSec: 24.6, transcript: "Most closets are full of crap. Buy quality." },
        extras: { quotables: ["Most closets are full of crap.", "Buy quality."], note: "", count: 2 },
      },
    });
    expect(out).toContain("THE CLIP (exactly what viewers hear — 12:34–13:01 of the pillar, 25s after cuts)");
    expect(out).toContain("Most closets are full of crap. Buy quality.");
    expect(out).toContain("CLIP IDEA EXTRAS");
    expect(out).toContain("- quotables:\n  1. Most closets are full of crap.\n  2. Buy quality.");
    expect(out).toContain("- count: 2");
    expect(out).not.toContain("- note"); // blank strings are dropped
  });

  it("stays silent when the clip has no words and the extras have nothing renderable", () => {
    expect(
      renderEditorialContextBlock({
        ...EMPTY_EC,
        clipIdea: { ...clipIdea, clip: { startSec: 0, endSec: 5, durationSec: 5, transcript: "  " }, extras: { picks: [1, 2], meta: { a: 1 } } },
      }),
    ).toBeNull();
    expect(renderClipIdeaExtras(null)).toBeNull();
  });
});
