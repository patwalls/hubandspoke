// Simulate a Business Interview hitting 50k views and trigger Asana tasks
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { pgTable, uuid, text, jsonb, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

/* ---- Schema fragments ---- */
const formats = pgTable('formats', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  brand: text('brand').notNull(),
  channels: jsonb('channels'),
  viewThreshold: integer('view_threshold'),
  contentType: text('content_type'),
  contentOwner: text('content_owner'),
  contentOwnerAsanaGid: text('content_owner_asana_gid'),
  instructions: text('instructions'),
});

const formatRepurposeMappings = pgTable('format_repurpose_mappings', {
  id: uuid('id').defaultRandom().primaryKey(),
  sourceFormatId: uuid('source_format_id').notNull(),
  targetFormatId: uuid('target_format_id').notNull(),
});

/* ---- DB connection ---- */
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

/* ---- Asana helpers ---- */
const ASANA_BASE = 'https://app.asana.com/api/1.0';
const MATG_PROJECT_GID = '1214030213173859';

function asanaHeaders() {
  return {
    Authorization: `Bearer ${process.env.ASANA_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function createAsanaTask({ name, notes, assigneeGid }) {
  const taskData = {
    name,
    notes: notes || '',
    projects: [MATG_PROJECT_GID],
  };
  if (assigneeGid) taskData.assignee = assigneeGid;

  const res = await fetch(`${ASANA_BASE}/tasks`, {
    method: 'POST',
    headers: asanaHeaders(),
    body: JSON.stringify({ data: taskData }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Asana createTask failed (${res.status}): ${err}`);
  }
  const json = await res.json();
  return json.data;
}

/* ---- Main ---- */
const SOURCE_FORMAT_ID = '5641425a-5f71-4cd1-ac74-b8a79a8421cd'; // Business Interview
const VIDEO_TITLE = 'Claude Cowork Just Did 7 Days of Work in 15 Minutes';
const VIEWS = 50000;

console.log('🎙️  Simulating: "' + VIDEO_TITLE + '" just hit ' + VIEWS.toLocaleString() + ' views!');
console.log('──────────────────────────────────────────────────────');

// 1. Fetch source format
const [source] = await db.select().from(formats).where(eq(formats.id, SOURCE_FORMAT_ID));
console.log(`\n📌 Source format: ${source.name} (threshold: ${source.viewThreshold?.toLocaleString()})`);

// 2. Fetch repurpose mappings
const mappings = await db.select().from(formatRepurposeMappings)
  .where(eq(formatRepurposeMappings.sourceFormatId, SOURCE_FORMAT_ID));
console.log(`🔗 Found ${mappings.length} repurpose targets\n`);

// 3. Fetch all target formats
const allFormats = await db.select().from(formats);
const targets = mappings
  .map(m => allFormats.find(f => f.id === m.targetFormatId))
  .filter(Boolean);

// 4. Create Asana tasks
console.log('Creating Asana tasks...\n');

for (const target of targets) {
  const taskName = `[Repurpose] ${target.name}: ${VIDEO_TITLE}`;

  const notesSections = [
    `Source format: ${source.name}`,
    `Target format: ${target.name}`,
    target.channels?.length ? `Channel(s): ${target.channels.join(', ')}` : null,
    target.contentOwner ? `Assigned to: ${target.contentOwner}` : null,
    `Video: ${VIDEO_TITLE}`,
    `Views at trigger: ${VIEWS.toLocaleString()}`,
    `Threshold: ${source.viewThreshold?.toLocaleString()}`,
  ].filter(Boolean);

  if (target.instructions) {
    notesSections.push('', '--- Format Instructions ---', target.instructions);
  }
  notesSections.push('', 'Created automatically by Hub & Spoke');

  const task = await createAsanaTask({
    name: taskName,
    notes: notesSections.join('\n'),
    assigneeGid: target.contentOwnerAsanaGid,
  });

  const assigneeInfo = target.contentOwner ? ` → ${target.contentOwner}` : '';
  console.log(`  ✅ ${target.name}${assigneeInfo}`);
  console.log(`     Task: ${taskName}`);
  console.log(`     Asana GID: ${task.gid}`);
  console.log(`     URL: https://app.asana.com/0/${MATG_PROJECT_GID}/${task.gid}`);
  console.log('');
}

console.log('──────────────────────────────────────────────────────');
console.log(`✨ Done! ${targets.length} tasks created in Asana.`);
console.log(`🔗 View project: https://app.asana.com/0/${MATG_PROJECT_GID}`);

await client.end();
