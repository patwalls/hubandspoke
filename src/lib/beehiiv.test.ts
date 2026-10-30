import { describe, expect, it } from "vitest";
import {
  assertAllowedBeehiivCall,
  assertSafeDraftCreate,
  assertSafeDraftUpdate,
  handEditedInBeehiiv,
  FUTUREPEDIA_PUBLICATION_ID as FP,
  HOWTO_AUTHOR_IDS,
  HOWTO_BASE_TEMPLATE_ID,
  HOWTO_POLL_ID,
  SKILL_LEAP_MEMBERS_SEGMENT_ID as SEG,
} from "./beehiiv";

const POST = "post_5dbaff2f-599c-4703-9f1b-fcfc7cc64f60";
const TEMPLATE = "post_template_76011007-958d-4538-89dc-40bbe45f87a1";
const OTHER_PUB = "pub_00000000-0000-0000-0000-000000000000";
const ok = (m: string, p: string) => expect(() => assertAllowedBeehiivCall(m, p)).not.toThrow();
const blocked = (m: string, p: string) => expect(() => assertAllowedBeehiivCall(m, p)).toThrow(/not on the allowlist/);

describe("assertAllowedBeehiivCall (read-only, Futurepedia only)", () => {
  it("allows reading Futurepedia's posts, templates and the Skill Leap segment's details", () => {
    ok("GET", "/publications?limit=100");
    ok("GET", `/publications/${FP}/posts?limit=50&page=2&status=confirmed&order_by=publish_date&direction=desc&expand%5B%5D=free_web_content`);
    ok("GET", `/publications/${FP}/posts/${POST}?expand%5B%5D=free_email_content&expand%5B%5D=recipients`);
    ok("GET", `/publications/${FP}/posts/${POST}?expand%5B%5D=stats`); // one post's aggregate numbers
    ok("GET", `/publications/${FP}/post_templates?limit=100`);
    ok("GET", `/publications/${FP}/post_templates/${TEMPLATE}?expand%5B%5D=free_web_content`);
    ok("GET", `/publications/${FP}/segments/${SEG}`);
  });

  it("allows creating a post and updating ONE post in Futurepedia; blocks deleting, bulk updates and everything else", () => {
    ok("POST", `/publications/${FP}/posts`);
    ok("PATCH", `/publications/${FP}/posts/${POST}`);
    blocked("POST", `/publications/${OTHER_PUB}/posts`);
    blocked("PATCH", `/publications/${OTHER_PUB}/posts/${POST}`);
    blocked("POST", `/publications/${FP}/posts?status=confirmed`);
    blocked("PATCH", `/publications/${FP}/posts/${POST}?status=confirmed`);
    blocked("PATCH", `/publications/${FP}/posts`);
    blocked("PUT", `/publications/${FP}/posts/${POST}`);
    blocked("DELETE", `/publications/${FP}/posts/${POST}`);
    blocked("POST", `/publications/${FP}/post_templates`);
  });

  it("blocks subscribers, segment members, other publications and unexpected query params", () => {
    blocked("GET", `/publications/${FP}/subscriptions`);
    blocked("GET", `/publications/${FP}/segments/${SEG}/results`);
    blocked("GET", `/publications/${FP}/segments`);
    blocked("GET", `/publications/${OTHER_PUB}/posts`);
    blocked("GET", `/publications/${FP}/posts?expand%5B%5D=stats`); // stats only ever on ONE post, never a list
    blocked("GET", `/publications/${FP}/post_templates/${TEMPLATE}?expand%5B%5D=stats`);
    blocked("GET", `/publications/${OTHER_PUB}/posts/${POST}?expand%5B%5D=stats`);
    blocked("GET", `/publications/${FP}/posts/${POST}?expand%5B%5D=subscribers`);
    blocked("GET", `/publications/${FP}/posts?email=someone@example.com`);
    blocked("GET", `/publications/${FP}/posts/${POST}/../subscriptions`);
  });
});

describe("assertSafeDraftCreate: a create can only ever make an unsent draft", () => {
  const safe = {
    title: "Turn Meeting Notes Into a Plan",
    subtitle: "A 10-minute workflow",
    post_template_id: HOWTO_BASE_TEMPLATE_ID,
    blocks: [{ type: "section", blocks: [{ type: "paragraph", plaintext: "Hi" }] }, { type: "poll", poll_id: HOWTO_POLL_ID }],
    guest_author_ids: [HOWTO_AUTHOR_IDS.kevin],
    status: "draft",
    recipients: { email: { tier_ids: ["free"], exclude_segment_ids: [SEG] }, web: { tier_ids: ["free"] } },
    email_settings: { email_subject_line: "Turn Meeting Notes Into a Plan", email_preview_text: "x", display_title_in_email: false, display_subtitle_in_email: false },
    web_settings: { slug: "turn-meeting-notes-into-a-plan-10-27-2026" },
  };
  const refuses = (patch: Record<string, unknown>, why: RegExp) => expect(() => assertSafeDraftCreate({ ...safe, ...patch })).toThrow(why);

  it("accepts a draft from the empty base template, by Kevin or Saj, that excludes Skill Leap members", () => {
    expect(() => assertSafeDraftCreate(safe)).not.toThrow();
    expect(() => assertSafeDraftCreate({ ...safe, guest_author_ids: [HOWTO_AUTHOR_IDS.saj] })).not.toThrow();
  });

  it("refuses body_content, an html block that could run code, risky block types, per-block audience targeting and other authors or polls", () => {
    refuses({ body_content: "<p>x</p>" }, /not allowed: body_content/);
    // The rendered email goes over as an html block (beehiiv-draft.ts): plain markup is fine, anything that runs or loads code is not.
    expect(() => assertSafeDraftCreate({ ...safe, blocks: [{ type: "html", html: "<table><tr><td style=\"color:#222\">x</td></tr></table>" }] })).not.toThrow();
    refuses({ blocks: [{ type: "html", html: "<p>x</p><script>1</script>" }] }, /may not contain <script/);
    refuses({ blocks: [{ type: "html", html: "" }] }, /needs its html/);
    refuses({ blocks: [{ type: "advertisement" }] }, /block type not allowed: advertisement/);
    refuses({ blocks: [{ type: "paragraph", plaintext: "x", visibility_settings: { include_segment_ids: ["seg_x"] } }] }, /visibility_settings/);
    refuses({ blocks: [{ type: "section", blocks: [{ type: "section", blocks: [] }] }] }, /nested/);
    refuses({ blocks: [{ type: "poll", poll_id: "poll_other" }] }, /feedback poll/);
    refuses({ guest_author_ids: ["guest_someone"] }, /Kevin or Saj/);
  });

  it("refuses anything that publishes or schedules", () => {
    refuses({ status: "confirmed" }, /status must be "draft"/);
    refuses({ status: undefined }, /status must be "draft"/);
    refuses({ scheduled_at: "2026-10-27T14:30:00Z" }, /not allowed: scheduled_at/);
    refuses({ override_scheduled_at: "2026-10-27T14:30:00Z" }, /not allowed: override_scheduled_at/);
    refuses({ newsletter_list_id: "list_1" }, /not allowed: newsletter_list_id/);
  });

  it("refuses other templates and an audience that doesn't exclude Skill Leap members or adds a segment", () => {
    refuses({ post_template_id: "post_template_00000000-0000-0000-0000-000000000000" }, /empty How-To base template/);
    refuses({ recipients: undefined }, /recipients are required/);
    refuses({ recipients: { email: { tier_ids: ["free"], exclude_segment_ids: [] } } }, /Skill Leap members segment must be excluded/);
    refuses({ recipients: { email: { tier_ids: ["free"], exclude_segment_ids: [SEG], include_segment_ids: ["seg_x"] } } }, /no segment may be added/);
    refuses({ email_settings: { email_subject_line: "x", send_at: "now" } }, /email_settings fields not allowed: send_at/);
  });
});

describe("assertSafeDraftUpdate: an update can only replace a draft's content and words", () => {
  const html = { type: "html", html: "<table><tr><td>Hello</td></tr></table>" };
  const fine = (b: unknown) => expect(() => assertSafeDraftUpdate(b)).not.toThrow();
  const refused = (b: unknown, why: RegExp) => expect(() => assertSafeDraftUpdate(b)).toThrow(why);

  it("accepts the body replaced, with or without the title / subject / preview", () => {
    fine({ blocks: [html], content_merge_strategy: "replace" });
    fine({ blocks: [html, { type: "section", blocks: [{ type: "poll", poll_id: HOWTO_POLL_ID }] }] });
    fine({ title: "New title", subtitle: "New preview", email_settings: { email_subject_line: "New subject", email_preview_text: "p" } });
    fine({ thumbnail_image_url: "https://img.youtube.com/vi/x/maxresdefault.jpg" });
  });

  it("refuses anything that sends, schedules, retargets or re-attributes the post", () => {
    refused({ blocks: [html], status: "confirmed" }, /fields not allowed: status/);
    refused({ blocks: [html], scheduled_at: "2026-10-28T13:00:00Z" }, /scheduled_at/);
    refused({ recipients: { email: { tier_ids: ["free"] } } }, /recipients/);
    refused({ guest_author_ids: [HOWTO_AUTHOR_IDS.saj] }, /guest_author_ids/);
    refused({ body_content: "<p>x</p>" }, /body_content/);
    refused({ web_settings: { slug: "x" } }, /web_settings/);
    refused({ custom_link_tracking_enabled: false }, /custom_link_tracking_enabled/);
  });

  it("refuses a merge that would keep the old copy, bad blocks, a blank title and an empty update", () => {
    refused({ blocks: [html], content_merge_strategy: "append" }, /must be "replace"/);
    refused({ content_merge_strategy: "replace" }, /needs blocks/);
    refused({ blocks: [] }, /non-empty/);
    refused({ blocks: [{ type: "html", html: "<script>x</script>" }] }, /script/);
    refused({ blocks: [{ type: "advertisement", opportunity_id: "x" }] }, /not allowed/);
    refused({ title: "  " }, /blank/);
    refused({ email_settings: { from_address: "x@y.z" } }, /email_settings fields not allowed/);
    refused({}, /nothing to update/);
    refused(null, /object/);
  });
});

describe("handEditedInBeehiiv: are the words we last sent still in the post?", () => {
  const pushedText = "Claude can make videos with nothing but code. Watch The Full Video →";
  const render = (inner: string) => `<html><body><div id="header"><a href="x">Kevin at Futurepedia</a></div><div id="content-blocks"><p>${inner}</p></div><div id="footer">Unsubscribe</div></body></html>`;

  it("passes when beehiiv's render still carries them, however it wraps or re-links the block", () => {
    expect(handEditedInBeehiiv(pushedText, render(`Claude can make videos with nothing but code. <a href="https://youtu.be/x?utm_source=futurepedia">Watch The Full Video</a> →`))).toBe(false);
  });

  it("flags a post whose words changed in beehiiv", () => {
    expect(handEditedInBeehiiv(pushedText, render("Claude can make videos with only code. Watch The Full Video →"))).toBe(true);
  });

  it("can't judge without a rendered email or a recorded push, so it passes", () => {
    expect(handEditedInBeehiiv(pushedText, null)).toBe(false);
    expect(handEditedInBeehiiv(pushedText, "")).toBe(false);
    expect(handEditedInBeehiiv(null, render("anything"))).toBe(false);
  });
});
