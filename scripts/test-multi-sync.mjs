// Test multi-platform sync for MATG
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { pgTable, uuid, text, date, boolean, integer, decimal, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { eq, and, inArray } from 'drizzle-orm';

/* ---- Minimal schema ---- */
const productionItems = pgTable("production_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  youtubeId: text("youtube_id").unique(),
  youtubeUrl: text("youtube_url"),
  thumbnail: text("thumbnail"),
  title: text("title"),
  publishedDate: date("published_date"),
  status: text("status"),
  platform: jsonb("platform"),
  format: text("format"),
  brand: text("brand").default("starter-story").notNull(),
  publishedLink: text("published_link"),
  isExternal: boolean("is_external").default(false).notNull(),
  views: integer("views"),
  likes: integer("likes"),
  comments: integer("comments"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

const syncLogs = pgTable("sync_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  syncType: text("sync_type").notNull(),
  status: text("status").notNull(),
  itemsFetched: integer("items_fetched"),
  itemsCreated: integer("items_created"),
  itemsUpdated: integer("items_updated"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

const SC_BASE = "https://api.scrapecreators.com";
const API_KEY = process.env.SCRAPE_CREATORS_API_KEY;
const headers = { "x-api-key": API_KEY };

/* ---- Helpers ---- */
async function getExistingByLinks(links) {
  if (links.length === 0) return new Map();
  const rows = await db.select({ id: productionItems.id, link: productionItems.publishedLink })
    .from(productionItems)
    .where(and(eq(productionItems.brand, "matg"), inArray(productionItems.publishedLink, links)));
  return new Map(rows.map(r => [r.link, r.id]));
}

function parseTwitterDate(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
}

function unixToDate(ts) {
  return ts ? new Date(ts * 1000).toISOString().split("T")[0] : null;
}

function parseRelativeTime(text) {
  if (!text) return null;
  const now = new Date();
  const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "day": now.setDate(now.getDate() - num); break;
    case "week": now.setDate(now.getDate() - num * 7); break;
    case "month": now.setMonth(now.getMonth() - num); break;
    case "year": now.setFullYear(now.getFullYear() - num); break;
    case "hour": now.setHours(now.getHours() - num); break;
    default: break;
  }
  return now.toISOString().split("T")[0];
}

const startedAt = new Date();
const results = [];

/* ---- 1. YouTube Videos ---- */
console.log("📺 Syncing YouTube Videos...");
try {
  const res = await fetch(`${SC_BASE}/v1/youtube/channel-videos?handle=MATGpod&sort=latest`, { headers });
  const data = await res.json();
  const videos = data.videos || [];
  console.log(`   Fetched ${videos.length} videos`);

  const links = videos.map(v => v.url).filter(Boolean);
  const existing = await getExistingByLinks(links);
  let created = 0, updated = 0;

  for (const v of videos) {
    const pubDate = v.publishedTime ? v.publishedTime.split("T")[0] : parseRelativeTime(v.publishedTimeText);
    const row = {
      title: v.title, youtubeUrl: v.url, thumbnail: v.thumbnail, publishedDate: pubDate,
      status: "Published", platform: ["YouTube"], format: "Business Interview",
      brand: "matg", publishedLink: v.url, views: v.viewCountInt || 0, isExternal: false, updatedAt: new Date(),
    };
    if (existing.has(v.url)) {
      await db.update(productionItems).set(row).where(eq(productionItems.id, existing.get(v.url)));
      updated++;
    } else {
      await db.insert(productionItems).values({ ...row, youtubeId: v.id });
      created++;
    }
  }
  console.log(`   ✅ ${created} new, ${updated} updated`);
  results.push({ source: "YouTube", fetched: videos.length, created, updated, errors: 0 });
} catch (e) { console.error("   ❌", e.message); results.push({ source: "YouTube", fetched: 0, created: 0, updated: 0, errors: 1 }); }

/* ---- 2. YouTube Shorts ---- */
console.log("\n📱 Syncing YouTube Shorts...");
try {
  const res = await fetch(`${SC_BASE}/v1/youtube/channel/shorts?handle=MATGpod`, { headers });
  const data = await res.json();
  const shorts = data.shorts || [];
  console.log(`   Fetched ${shorts.length} shorts`);

  const links = shorts.map(s => s.url).filter(Boolean);
  const existing = await getExistingByLinks(links);
  let created = 0, updated = 0;

  for (const s of shorts) {
    const pubDate = s.publishDate ? s.publishDate.split("T")[0] : null;
    const row = {
      title: s.title, youtubeUrl: s.url, thumbnail: null, publishedDate: pubDate,
      status: "Published", platform: ["YouTube Shorts"], format: "YouTube Short",
      brand: "matg", publishedLink: s.url, views: s.viewCountInt || 0,
      likes: s.likeCountInt || null, comments: s.commentCountInt || null,
      isExternal: false, updatedAt: new Date(),
    };
    if (existing.has(s.url)) {
      await db.update(productionItems).set(row).where(eq(productionItems.id, existing.get(s.url)));
      updated++;
    } else {
      await db.insert(productionItems).values({ ...row, youtubeId: s.id });
      created++;
    }
  }
  console.log(`   ✅ ${created} new, ${updated} updated`);
  results.push({ source: "YouTube Shorts", fetched: shorts.length, created, updated, errors: 0 });
} catch (e) { console.error("   ❌", e.message); results.push({ source: "YouTube Shorts", fetched: 0, created: 0, updated: 0, errors: 1 }); }

/* ---- 3. Instagram ---- */
console.log("\n📸 Syncing Instagram...");
try {
  const res = await fetch(`${SC_BASE}/v2/instagram/user/posts?handle=matgpod`, { headers });
  const data = await res.json();
  const posts = data.items || [];
  console.log(`   Fetched ${posts.length} posts`);

  const links = posts.map(p => p.url || `https://www.instagram.com/p/${p.code}/`);
  const existing = await getExistingByLinks(links);
  let created = 0, updated = 0;

  for (const p of posts) {
    const postUrl = p.url || `https://www.instagram.com/p/${p.code}/`;
    const caption = p.caption?.text || "";
    const isReel = p.product_type === "clips" || p.media_type === 2;
    const thumb = p.image_versions2?.candidates?.[0]?.url || null;
    const row = {
      title: caption ? caption.slice(0, 120) + (caption.length > 120 ? "..." : "") : "(No caption)",
      thumbnail: thumb, publishedDate: unixToDate(p.taken_at),
      status: "Published", platform: [isReel ? "Instagram Reel" : "Instagram Post"],
      format: isReel ? "Instagram Reel" : "Instagram Post",
      brand: "matg", publishedLink: postUrl,
      views: p.play_count || null, likes: p.like_count || null, comments: p.comment_count || null,
      isExternal: false, updatedAt: new Date(),
    };
    if (existing.has(postUrl)) {
      await db.update(productionItems).set(row).where(eq(productionItems.id, existing.get(postUrl)));
      updated++;
    } else {
      await db.insert(productionItems).values(row);
      created++;
    }
  }
  console.log(`   ✅ ${created} new, ${updated} updated`);
  results.push({ source: "Instagram", fetched: posts.length, created, updated, errors: 0 });
} catch (e) { console.error("   ❌", e.message); results.push({ source: "Instagram", fetched: 0, created: 0, updated: 0, errors: 1 }); }

/* ---- 4. Twitter ---- */
console.log("\n🐦 Syncing Twitter...");
try {
  const res = await fetch(`${SC_BASE}/v1/twitter/user-tweets?handle=matgpod`, { headers });
  const data = await res.json();
  const tweets = data.tweets || [];
  console.log(`   Fetched ${tweets.length} tweets`);

  const links = tweets.map(t => t.url).filter(Boolean);
  const existing = await getExistingByLinks(links);
  let created = 0, updated = 0;

  for (const t of tweets) {
    const legacy = t.legacy;
    if (!legacy) continue;
    const text = legacy.full_text || "";
    const viewCount = t.views?.count ? parseInt(t.views.count) : null;
    const thumb = legacy.entities?.media?.[0]?.media_url_https || null;
    const row = {
      title: text.length > 120 ? text.slice(0, 120) + "..." : text,
      thumbnail: thumb, publishedDate: parseTwitterDate(legacy.created_at),
      status: "Published", platform: ["Twitter"], format: "Tweet",
      brand: "matg", publishedLink: t.url,
      views: viewCount, likes: legacy.favorite_count || null, comments: legacy.reply_count || null,
      isExternal: false, updatedAt: new Date(),
    };
    if (existing.has(t.url)) {
      await db.update(productionItems).set(row).where(eq(productionItems.id, existing.get(t.url)));
      updated++;
    } else {
      await db.insert(productionItems).values(row);
      created++;
    }
  }
  console.log(`   ✅ ${created} new, ${updated} updated`);
  results.push({ source: "Twitter", fetched: tweets.length, created, updated, errors: 0 });
} catch (e) { console.error("   ❌", e.message); results.push({ source: "Twitter", fetched: 0, created: 0, updated: 0, errors: 1 }); }

/* ---- Summary ---- */
const total = { fetched: 0, created: 0, updated: 0, errors: 0 };
results.forEach(r => { total.fetched += r.fetched; total.created += r.created; total.updated += r.updated; total.errors += r.errors; });

// Log sync
await db.insert(syncLogs).values({
  syncType: "matg-all",
  status: total.errors > 0 && total.fetched === 0 ? "error" : "success",
  itemsFetched: total.fetched,
  itemsCreated: total.created,
  itemsUpdated: total.updated,
  startedAt,
  completedAt: new Date(),
});

console.log("\n══════════════════════════════════════════════");
console.log(`✨ MATG Multi-Platform Sync Complete`);
console.log(`   Total: ${total.fetched} fetched, ${total.created} new, ${total.updated} updated, ${total.errors} errors`);
console.log(`   Credits used: ${results.length}`);
results.forEach(r => console.log(`   ${r.source}: ${r.fetched} items (${r.created} new, ${r.updated} updated)`));
console.log("══════════════════════════════════════════════");

await client.end();
