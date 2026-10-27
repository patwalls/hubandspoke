import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAllowedHubspotCall, buildHtmlEmailContent, createDraftEmailFromTemplate, emailRichTextHtml, HUBSPOT_EMAIL_HTML_MODULE_ID } from "./hubspot-marketing-email";

describe("buildHtmlEmailContent", () => {
  // The shape of "[TEMPLATE] Sunday Breakfast – Hub & Spoke": masthead section, course sections (label + divider + rich text), footer section.
  const email = {
    id: "9",
    content: {
      flexAreas: {
        main: {
          boxed: false,
          sections: [
            { id: "s1", columns: [{ id: "c1", widgets: ["masthead"], width: 12 }], style: { paddingTop: "10px" } },
            { id: "s2", columns: [{ id: "c2", widgets: ["intro"], width: 12 }] },
            { id: "s3", columns: [{ id: "c3", widgets: ["label", "divider1", "orange_juice"], width: 12 }] },
            { id: "s4", columns: [{ id: "c4", widgets: ["divider2", "footer"], width: 12 }], style: { backgroundColor: "#fff" } },
          ],
        },
      },
      widgets: {
        masthead: { body: { path: "@hubspot/image_email" } },
        intro: { body: { path: "@hubspot/rich_text", html: "<p>old</p>", css_class: "x", hs_enable_module_padding: true, hs_wrapper_css: { "padding-top": "10px" } } },
        label: { body: { label_text: "The Orange Juice 🍊" } },
        divider1: { body: { path: "@hubspot/email_divider" } },
        orange_juice: { body: { path: "@hubspot/rich_text", html: "<p>old</p>" } },
        divider2: { body: { path: "@hubspot/email_divider" } },
        footer: { body: { path: "@hubspot/email_footer", footer_html: "unsubscribe" } },
        preview_text: { body: { value: "old preview" } },
      },
    },
  };

  it("keeps two sections — the first rich-text block's slot holding the email, and the footer with its divider — and drops the rest", () => {
    const { flexAreas, widgets } = buildHtmlEmailContent(email, "<table>email</table>", "Starter Story Sunday Breakfast");
    expect(flexAreas.main?.sections?.map((s) => s.columns.map((c) => c.widgets))).toEqual([[["intro"]], [["divider2", "footer"]]]);
    expect(flexAreas.main?.boxed).toBe(false); // the layout's other settings stay
    expect(flexAreas.main?.sections?.[1].style).toEqual({ backgroundColor: "#fff" }); // and so does the footer section's style
    expect(Object.keys(widgets).sort()).toEqual(["divider2", "footer", "intro", "preview_text"]);
    expect(widgets.intro.body?.html).toBe("<table>email</table>");
    expect(widgets.footer).toEqual(email.content.widgets.footer);
    expect(widgets.preview_text.body?.value).toBe("Starter Story Sunday Breakfast");
  });

  // 2026-10-27: in a @hubspot/rich_text block, HubSpot's editor stripped every <table> and <img> the moment
  // someone opened the email (drafts 225543005016, 225667625797) — the test send went out unstyled.
  it("puts the email in the Hub & Spoke email module, never in a rich-text block the HubSpot editor rewrites", () => {
    const { widgets } = buildHtmlEmailContent(email, "<table><tr><td><img src=x></td></tr></table>", null);
    for (const w of Object.values(widgets)) expect(w.body?.path).not.toBe("@hubspot/rich_text");
    expect(widgets.intro).toMatchObject({ type: "module", module_id: HUBSPOT_EMAIL_HTML_MODULE_ID, body: { module_id: HUBSPOT_EMAIL_HTML_MODULE_ID } });
    expect(widgets.intro.body?.css_class).toBeUndefined(); // nothing of the rich-text block's settings carried over
    // Link extraction for past issues still sees the module's HTML.
    expect(emailRichTextHtml({ id: "1", content: { widgets } })).toContain("<img src=x>");
  });

  it("turns HubSpot's padding around the email block off (the email carries its own)", () => {
    const { widgets } = buildHtmlEmailContent(email, "<p>x</p>", null);
    expect(widgets.intro.body?.hs_enable_module_padding).toBe(false);
    expect(widgets.intro.body?.hs_wrapper_css).toEqual({ "padding-top": "0px", "padding-right": "0px", "padding-bottom": "0px", "padding-left": "0px" });
    expect(widgets.preview_text.body?.value).toBe("");
  });

  it("fails loudly on a template with no rich-text block or no footer", () => {
    const without = (id: string) => ({
      id: "9",
      content: {
        flexAreas: { main: { sections: email.content.flexAreas.main.sections.map((s) => ({ ...s, columns: s.columns.map((c) => ({ ...c, widgets: c.widgets.filter((w) => w !== id) })) })) } },
        widgets: Object.fromEntries(Object.entries(email.content.widgets).filter(([k]) => k !== id)),
      },
    });
    expect(() => buildHtmlEmailContent(without("footer"), "<p>x</p>", null)).toThrow(/no footer block/);
    const noRich = without("intro");
    noRich.content.widgets = Object.fromEntries(Object.entries(noRich.content.widgets).filter(([k]) => k !== "orange_juice"));
    expect(() => buildHtmlEmailContent(noRich, "<p>x</p>", null)).toThrow(/no rich-text block/);
  });
});

describe("assertAllowedHubspotCall", () => {
  it("allows only reading, cloning and editing marketing emails", () => {
    expect(() => assertAllowedHubspotCall("GET", "/marketing/v3/emails/123")).not.toThrow();
    expect(() => assertAllowedHubspotCall("GET", "/marketing/v3/emails/123?includeStats=true")).not.toThrow();
    expect(() => assertAllowedHubspotCall("post", "/marketing/v3/emails/clone")).not.toThrow();
    expect(() => assertAllowedHubspotCall("PATCH", "/marketing/v3/emails/123")).not.toThrow();
    expect(() => assertAllowedHubspotCall("GET", "/marketing/v3/emails?limit=100&createdAfter=2026-06-01T00%3A00%3A00.000Z")).not.toThrow();
    expect(() =>
      assertAllowedHubspotCall("GET", "/marketing/v3/emails?limit=100&createdAfter=2026-06-01T00%3A00%3A00.000Z&after=Mg%3D%3D"),
    ).not.toThrow();
  });

  it("only allows the email list as a read with limit + date + cursor — no other params or methods", () => {
    expect(() => assertAllowedHubspotCall("GET", "/marketing/v3/emails?limit=100")).toThrow();
    expect(() => assertAllowedHubspotCall("GET", "/marketing/v3/emails?limit=100&createdAfter=x&archived=true")).toThrow();
    expect(() => assertAllowedHubspotCall("POST", "/marketing/v3/emails?limit=100&createdAfter=2026")).toThrow();
  });

  it("blocks sending, publishing, deleting and anything outside marketing emails", () => {
    for (const [method, path] of [
      ["POST", "/marketing/v3/emails/123/publish"],
      ["POST", "/marketing/v3/emails/123/unpublish"],
      ["POST", "/marketing/v3/transactional/single-email/send"],
      ["DELETE", "/marketing/v3/emails/123"],
      ["GET", "/crm/v3/objects/contacts"],
      ["GET", "/marketing/v3/emails"],
      ["PATCH", "/marketing/v3/emails/123/draft"],
      ["GET", "/marketing/v3/emails/123?archived=true"],
    ]) {
      expect(() => assertAllowedHubspotCall(method, path), `${method} ${path}`).toThrow(/Blocked HubSpot call/);
    }
  });
});

describe("createDraftEmailFromTemplate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const template = {
    id: "9",
    content: {
      flexAreas: { main: { sections: [{ id: "s1", columns: [{ id: "c1", widgets: ["body"], width: 12 }] }, { id: "s2", columns: [{ id: "c2", widgets: ["footer"], width: 12 }] }] } },
      widgets: { body: { body: { path: "@hubspot/rich_text", html: "<p>old</p>" } }, footer: { body: { path: "@hubspot/email_footer" } } },
    },
  };
  /** A HubSpot that stores the PATCHed content, passing the stored module html through `mangle` (what HubSpot keeps). */
  const fakeHubspot = (mangle: (html: string) => string) => {
    let stored: unknown = template.content;
    return vi.fn(async (url: string, init: { method: string; body?: string }) => {
      const path = new URL(url).pathname;
      if (init.method === "POST") return new Response(JSON.stringify({ id: "777" }), { status: 200 });
      if (init.method === "PATCH") {
        const c = JSON.parse(init.body!).content;
        for (const w of Object.values(c.widgets) as { body?: { html?: string } }[]) if (w.body?.html) w.body.html = mangle(w.body.html);
        stored = c;
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ id: path.split("/").pop(), content: stored }), { status: 200 });
    });
  };

  it("reads the email back and succeeds when HubSpot kept the design byte for byte", async () => {
    vi.stubEnv("HUBSPOT_PORTAL_53_ACCESS_TOKEN", "test");
    vi.stubGlobal("fetch", fakeHubspot((h) => h));
    const r = await createDraftEmailFromTemplate({ templateEmailId: "9", name: "n", subject: "s", previewText: null, html: "<table><tr><td>x</td></tr></table>" });
    expect(r.id).toBe("777");
  });

  it("fails, naming the copy, when HubSpot didn't keep the design as sent", async () => {
    vi.stubEnv("HUBSPOT_PORTAL_53_ACCESS_TOKEN", "test");
    vi.stubGlobal("fetch", fakeHubspot((h) => h.replace(/<\/?(table|tr|td)>/g, "")));
    const err = await createDraftEmailFromTemplate({ templateEmailId: "9", name: "n", subject: "s", previewText: null, html: "<table><tr><td>x</td></tr></table>" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/didn't keep the email's design/);
    expect((err as Error).message).toContain("/edit/777/");
  });

  it("when filling the copy fails, the error names the half-made copy so it gets deleted, not duplicated by a retry", async () => {
    vi.stubEnv("HUBSPOT_PORTAL_53_ACCESS_TOKEN", "test");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { method: string }) => {
        calls.push(`${init.method} ${new URL(url).pathname}`);
        if (init.method === "POST") return new Response(JSON.stringify({ id: "777" }), { status: 200 });
        if (init.method === "GET") return new Response(JSON.stringify({ id: "777", content: {} }), { status: 200 });
        return new Response("nope", { status: 500 });
      }),
    );
    const err = await createDraftEmailFromTemplate({ templateEmailId: "9", name: "n", subject: "s", previewText: null, html: "<p>x</p>" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("/edit/777/");
    expect((err as Error).message).toMatch(/delete it/i);
    expect(calls).toEqual(["POST /marketing/v3/emails/clone", "GET /marketing/v3/emails/777"]);
  });
});
