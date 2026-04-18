import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, integer } from 'drizzle-orm/pg-core';

const ASANA_BASE = 'https://app.asana.com/api/1.0';
const MATG_PROJECT_GID = '1214030213173859';

const formats = pgTable('formats', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  brand: text('brand').notNull(),
  channels: jsonb('channels'),
  viewThreshold: integer('view_threshold'),
  parentFormatId: uuid('parent_format_id'),
  contentOwner: text('content_owner'),
});

async function createAsanaTask(name, notes) {
  const res = await fetch(`${ASANA_BASE}/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ASANA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: { name, notes, projects: [MATG_PROJECT_GID] },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Asana error (${res.status}): ${err}`);
  }
  const json = await res.json();
  return json.data;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL);
  const db = drizzle(sql);

  const sourceFormatId = '5641425a-5f71-4cd1-ac74-b8a79a8421cd';
  const videoTitle = 'How This Founder Built a $10M Business in 2 Years';
  const views = 52347;

  // Fetch source format
  const [source] = await db.select().from(formats).where(eq(formats.id, sourceFormatId));
  console.log(`Source format: ${source.name} | Threshold: ${source.viewThreshold}`);

  // Direct children of this source format
  const targets = await db.select().from(formats)
    .where(eq(formats.parentFormatId, sourceFormatId));
  console.log(`Repurpose targets: ${targets.length}`);

  // Create Asana tasks
  const results = [];
  for (const target of targets) {
    const taskName = `[Repurpose] ${target.name}: ${videoTitle}`;
    const notes = [
      `Source format: ${source.name}`,
      `Target format: ${target.name}`,
      target.channels ? `Channel(s): ${target.channels.join(', ')}` : null,
      `Video: ${videoTitle}`,
      `Views at trigger: ${views.toLocaleString()}`,
      `Threshold: ${(source.viewThreshold || 0).toLocaleString()}`,
      ``,
      `Created automatically by Hub & Spoke`,
    ].filter(x => x !== null).join('\n');

    console.log(`Creating task: ${taskName}`);
    const task = await createAsanaTask(taskName, notes);
    results.push({ format: target.name, gid: task.gid });
    console.log(`  -> Created! GID: ${task.gid}`);
  }

  console.log('\n=== DONE ===');
  console.log(JSON.stringify(results, null, 2));

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
