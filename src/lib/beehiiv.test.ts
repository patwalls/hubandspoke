import { describe, expect, it } from "vitest";
import { assertAllowedBeehiivCall, FUTUREPEDIA_PUBLICATION_ID as FP, SKILL_LEAP_MEMBERS_SEGMENT_ID as SEG } from "./beehiiv";

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

  it("blocks every write: creating, updating, deleting, publishing", () => {
    blocked("POST", `/publications/${FP}/posts`);
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
