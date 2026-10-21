import { describe, expect, it } from "vitest";
import {
  assertAllowedBeehiivCall,
  assertSafeDraftCreate,
  FUTUREPEDIA_PUBLICATION_ID as FP,
  HOWTO_POST_TEMPLATE_IDS,
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
    ok("GET", `/publications/${FP}/post_templates?limit=100`);
    ok("GET", `/publications/${FP}/post_templates/${TEMPLATE}?expand%5B%5D=free_web_content`);
    ok("GET", `/publications/${FP}/segments/${SEG}`);
  });

  it("allows only creating a post in Futurepedia; blocks updating, deleting and everything else", () => {
    ok("POST", `/publications/${FP}/posts`);
    blocked("POST", `/publications/${OTHER_PUB}/posts`);
    blocked("POST", `/publications/${FP}/posts?status=confirmed`);
    blocked("PATCH", `/publications/${FP}/posts/${POST}`);
    blocked("PUT", `/publications/${FP}/posts/${POST}`);
    blocked("DELETE", `/publications/${FP}/posts/${POST}`);
    blocked("POST", `/publications/${FP}/post_templates`);
  });

  it("blocks subscribers, segment members, other publications and unexpected query params", () => {
    blocked("GET", `/publications/${FP}/subscriptions`);
    blocked("GET", `/publications/${FP}/segments/${SEG}/results`);
    blocked("GET", `/publications/${FP}/segments`);
    blocked("GET", `/publications/${OTHER_PUB}/posts`);
    blocked("GET", `/publications/${FP}/posts?expand%5B%5D=stats`);
    blocked("GET", `/publications/${FP}/posts?email=someone@example.com`);
    blocked("GET", `/publications/${FP}/posts/${POST}/../subscriptions`);
  });
});

describe("assertSafeDraftCreate: a create can only ever make an unsent draft", () => {
  const safe = {
    title: "Turn Meeting Notes Into a Plan",
    subtitle: "A 10-minute workflow",
    post_template_id: HOWTO_POST_TEMPLATE_IDS.kevin,
    body_content: "<p>Hi</p>",
    status: "draft",
    recipients: { email: { tier_ids: ["free"], exclude_segment_ids: [SEG] }, web: { tier_ids: ["free"] } },
    email_settings: { email_subject_line: "Turn Meeting Notes Into a Plan", email_preview_text: "x", display_title_in_email: false, display_subtitle_in_email: false },
    web_settings: { slug: "turn-meeting-notes-into-a-plan-10-27-2026" },
  };
  const refuses = (patch: Record<string, unknown>, why: RegExp) => expect(() => assertSafeDraftCreate({ ...safe, ...patch })).toThrow(why);

  it("accepts a draft from Kevin's or Saj's template that excludes Skill Leap members", () => {
    expect(() => assertSafeDraftCreate(safe)).not.toThrow();
    expect(() => assertSafeDraftCreate({ ...safe, post_template_id: HOWTO_POST_TEMPLATE_IDS.saj })).not.toThrow();
  });

  it("refuses anything that publishes or schedules", () => {
    refuses({ status: "confirmed" }, /status must be "draft"/);
    refuses({ status: undefined }, /status must be "draft"/);
    refuses({ scheduled_at: "2026-10-27T14:30:00Z" }, /not allowed: scheduled_at/);
    refuses({ override_scheduled_at: "2026-10-27T14:30:00Z" }, /not allowed: override_scheduled_at/);
    refuses({ newsletter_list_id: "list_1" }, /not allowed: newsletter_list_id/);
  });

  it("refuses other templates and an audience that doesn't exclude Skill Leap members or adds a segment", () => {
    refuses({ post_template_id: "post_template_00000000-0000-0000-0000-000000000000" }, /Kevin or Saj template/);
    refuses({ recipients: undefined }, /recipients are required/);
    refuses({ recipients: { email: { tier_ids: ["free"], exclude_segment_ids: [] } } }, /Skill Leap members segment must be excluded/);
    refuses({ recipients: { email: { tier_ids: ["free"], exclude_segment_ids: [SEG], include_segment_ids: ["seg_x"] } } }, /no segment may be added/);
    refuses({ email_settings: { email_subject_line: "x", send_at: "now" } }, /email_settings fields not allowed: send_at/);
  });
});
