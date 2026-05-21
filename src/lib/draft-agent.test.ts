import { describe, expect, it } from "vitest";
import { findEmptyRequiredFields } from "./draft-agent";
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
