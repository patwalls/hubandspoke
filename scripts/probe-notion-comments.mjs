import { Client } from "@notionhq/client";

const blockId = process.argv[2] || "28a8e70a-6a3e-81fb-b377-fd86a0a3391a";
const notion = new Client({ auth: process.env.NOTION_API_SECRET });
const res = await notion.comments.list({ block_id: blockId });
const userIds = [...new Set(res.results.map((c) => c.created_by?.id).filter(Boolean))];
console.log(`--- distinct user IDs: ${userIds.length} ---`);
for (const uid of userIds) {
  try {
    const u = await notion.users.retrieve({ user_id: uid });
    console.log(`USER ${uid}: ${JSON.stringify(u)}`);
  } catch (e) {
    console.log(`USER ${uid}: ERROR ${e.code ?? ""} ${e.message}`);
  }
}
