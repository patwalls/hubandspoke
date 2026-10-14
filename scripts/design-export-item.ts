/**
 * Dev/ops tool: export (render) a production item's design the way the
 * editor's "Export post" does — same service, same workflow side effects —
 * for a user by email. Used to render a demo on a one-off dyno:
 *
 *   heroku run --app hubandspoke -- npx tsx scripts/design-export-item.ts <productionItemId> <userEmail>
 */
import { eq } from "drizzle-orm";

async function main() {
  const [itemId, email] = process.argv.slice(2);
  if (!itemId || !email) throw new Error("usage: design-export-item.ts <productionItemId> <userEmail>");
  const { db } = await import("../src/lib/db");
  const { users } = await import("../src/lib/db/schema");
  const { exportDesign } = await import("../src/lib/services/design-editor/export");
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new Error(`no user ${email}`);
  const result = await exportDesign({ productionItemId: itemId, actorUserId: user.id });
  console.log(JSON.stringify(result));
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
