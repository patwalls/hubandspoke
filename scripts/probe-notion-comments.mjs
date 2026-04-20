import { Client } from "@notionhq/client";

const blockId = process.argv[2] || "28a8e70a-6a3e-81fb-b377-fd86a0a3391a";
const notion = new Client({ auth: process.env.NOTION_API_SECRET });
const res = await notion.comments.list({ block_id: blockId });
for (const c of res.results.slice(0, 5)) {
  console.log(JSON.stringify({
    id: c.id,
    created_by: c.created_by,
    rich_text_preview: c.rich_text?.map((r) => r.plain_text).join("").slice(0, 80),
  }, null, 2));
}
