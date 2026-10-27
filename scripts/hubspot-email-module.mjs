// One-shot setup (idempotent): writes the "Hub & Spoke email" custom module
// into HubSpot account 20627419's Design Manager and prints its module id.
//
// Why: the newsletter push used to put the whole email (tables, masthead
// image, inline CSS) into a @hubspot/rich_text block. HubSpot's editor
// re-sanitizes rich text when anyone OPENS the email and autosaves the
// result — every <table> and <img> gone (2026-10-27, drafts 225543005016 and
// 225667625797). This module holds the HTML in a plain text field and prints
// it verbatim, so nothing in the editor rewrites it. The push fills it;
// src/lib/hubspot-marketing-email.ts → HUBSPOT_EMAIL_HTML_MODULE_ID.
//
// Run: HUBSPOT_PORTAL_53_ACCESS_TOKEN=… node scripts/hubspot-email-module.mjs
// (or heroku run --app hubandspoke node scripts/hubspot-email-module.mjs).
// Re-running overwrites the files in place; the module id doesn't change.

const token = process.env.HUBSPOT_PORTAL_53_ACCESS_TOKEN;
if (!token) throw new Error("HUBSPOT_PORTAL_53_ACCESS_TOKEN not set");
const DIR = "Hub and Spoke/Hub and Spoke email.module";

const files = {
  "meta.json": JSON.stringify(
    {
      label: "Hub & Spoke email (edit in Hub & Spoke)",
      host_template_types: ["EMAIL"],
      content_types: ["EMAIL"],
      is_available_for_new_content: false,
      smart_type: "NOT_SMART",
      categories: ["text"],
    },
    null,
    2,
  ),
  "fields.json": JSON.stringify(
    [
      {
        name: "html",
        label: "Email HTML — written by Hub & Spoke. Change the email there and re-push; edits here are overwritten.",
        type: "text",
        allow_new_line: true,
        required: false,
        locked: false,
        default: "",
      },
    ],
    null,
    2,
  ),
  "module.html": "{{ module.html|safe }}\n",
  "module.css": "",
};

for (const [name, body] of Object.entries(files)) {
  const path = encodeURIComponent(`${DIR}/${name}`).replace(/%2F/g, "/");
  const form = new FormData();
  form.append("file", new Blob([body], { type: "text/plain" }), name);
  const res = await fetch(`https://api.hubapi.com/cms/v3/source-code/published/content/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`PUT ${name} → ${res.status}: ${(await res.text()).slice(0, 500)}`);
  console.log(`wrote ${DIR}/${name}`);
}

const meta = await fetch(`https://api.hubapi.com/content/api/v4/custom_widgets?limit=50&name=${encodeURIComponent("Hub and Spoke email")}`, {
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json());
const mod = (meta.objects ?? []).find((m) => m.path === "/Hub and Spoke/Hub and Spoke email");
console.log(mod ? `module id: ${mod.moduleId ?? mod.id}` : `module written; look its id up: ${JSON.stringify(meta).slice(0, 300)}`);
