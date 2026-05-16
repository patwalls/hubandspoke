import { enrichNewsletterItem } from "../src/lib/services/enrichment/newsletter";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: _smoke-newsletter-enrich.ts <production_item_id>");
    process.exit(1);
  }
  const r = await enrichNewsletterItem(id);
  const u = r.updates;
  console.log({
    htmlLen:
      typeof u.newsletterBodyHtml === "string"
        ? u.newsletterBodyHtml.length
        : null,
    platformContentIdStamped: u.platformContentId ?? "(not updated)",
    title: u.title,
    preview:
      typeof u.newsletterPreviewText === "string"
        ? u.newsletterPreviewText.slice(0, 80)
        : null,
    author: u.authorHandle,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
