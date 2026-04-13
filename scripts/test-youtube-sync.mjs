import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, isNotNull } from 'drizzle-orm';
import { pgTable, uuid, text, date, boolean, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';

const SCRAPE_CREATORS_BASE = 'https://api.scrapecreators.com/v1/youtube';
const MATG_HANDLE = 'MATGpod';

const productionItems = pgTable('production_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  youtubeId: text('youtube_id').unique(),
  youtubeUrl: text('youtube_url'),
  thumbnail: text('thumbnail'),
  title: text('title'),
  publishedDate: date('published_date'),
  status: text('status'),
  platform: jsonb('platform'),
  brand: text('brand').default('starter-story').notNull(),
  publishedLink: text('published_link'),
  isExternal: boolean('is_external').default(false).notNull(),
  views: integer('views'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

function parseRelativeTime(text) {
  if (!text) return null;
  const now = new Date();
  const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 'second': now.setSeconds(now.getSeconds() - num); break;
    case 'minute': now.setMinutes(now.getMinutes() - num); break;
    case 'hour': now.setHours(now.getHours() - num); break;
    case 'day': now.setDate(now.getDate() - num); break;
    case 'week': now.setDate(now.getDate() - num * 7); break;
    case 'month': now.setMonth(now.getMonth() - num); break;
    case 'year': now.setFullYear(now.getFullYear() - num); break;
  }
  return now.toISOString().split('T')[0];
}

async function main() {
  console.log('Fetching MATG videos from Scrape Creators...');
  const res = await fetch(`${SCRAPE_CREATORS_BASE}/channel-videos?handle=${MATG_HANDLE}&sort=latest`, {
    headers: { 'x-api-key': process.env.SCRAPE_CREATORS_API_KEY },
  });

  if (!res.ok) {
    console.error('API Error:', res.status, await res.text());
    process.exit(1);
  }

  const data = await res.json();
  const videos = data.videos || [];
  console.log(`Fetched ${videos.length} videos`);

  const sql = postgres(process.env.DATABASE_URL);
  const db = drizzle(sql);

  let created = 0;
  let updated = 0;

  // Get existing
  const existing = await db.select({ id: productionItems.id, youtubeId: productionItems.youtubeId })
    .from(productionItems)
    .where(and(eq(productionItems.brand, 'matg'), isNotNull(productionItems.youtubeId)));

  const existingMap = new Map(existing.map(e => [e.youtubeId, e.id]));
  console.log(`Existing MATG items: ${existing.length}`);

  for (const video of videos) {
    const publishedDate = video.publishedTime
      ? video.publishedTime.split('T')[0]
      : parseRelativeTime(video.publishedTimeText);

    const videoData = {
      title: video.title,
      youtubeUrl: video.url,
      thumbnail: video.thumbnail,
      publishedDate,
      status: 'Published',
      platform: ['YouTube'],
      brand: 'matg',
      publishedLink: video.url,
      views: video.viewCountInt || 0,
      isExternal: false,
      updatedAt: new Date(),
    };

    if (existingMap.has(video.id)) {
      await db.update(productionItems).set(videoData).where(eq(productionItems.id, existingMap.get(video.id)));
      updated++;
    } else {
      await db.insert(productionItems).values({ ...videoData, youtubeId: video.id });
      created++;
    }
  }

  console.log(`Done! Created: ${created}, Updated: ${updated}`);

  // Verify
  const count = await sql`SELECT count(*) as cnt FROM production_items WHERE brand = 'matg'`;
  console.log(`Total MATG items in DB: ${count[0].cnt}`);

  const sample = await sql`SELECT title, views, published_date FROM production_items WHERE brand = 'matg' ORDER BY published_date DESC LIMIT 3`;
  sample.forEach(s => console.log(`  ${s.title} | ${s.views} views | ${s.published_date}`));

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
