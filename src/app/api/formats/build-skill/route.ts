import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit } from "@/lib/auth-guards";
import { buildFormatSkill, type SkillAnswer } from "@/lib/services/build-format-skill";
import type { FormatFamily } from "@/lib/format-kinds";

// "Build with AI" on the format Skill box (Add format dialog + format
// detail page). One Haiku call per click; returns text, saves nothing.

const FAMILIES: ReadonlySet<string> = new Set(["clip", "design", "pillar", "newsletter"]);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ANSWER = 1500;
const MAX_EXISTING = 20_000;

interface Body {
  brand?: string;
  family?: string;
  kindLabel?: string;
  formatName?: string | null;
  answers?: SkillAnswer[];
  existing?: string | null;
  images?: { mediaType: string; dataB64: string }[];
  fromExamples?: boolean;
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const brand = (body.brand ?? "").trim();
  if (!brand) return NextResponse.json({ error: "brand is required" }, { status: 400 });
  const guard = await requireBrandEdit(brand);
  if (guard.response) return guard.response;

  if (!body.family || !FAMILIES.has(body.family)) {
    return NextResponse.json({ error: "family is required" }, { status: 400 });
  }
  const answers = (Array.isArray(body.answers) ? body.answers : [])
    .filter((a) => a && typeof a.question === "string" && typeof a.answer === "string")
    .map((a) => ({ question: a.question.slice(0, 200), answer: a.answer.slice(0, MAX_ANSWER) }));

  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > MAX_IMAGES) {
    return NextResponse.json({ error: `Up to ${MAX_IMAGES} screenshots` }, { status: 400 });
  }
  for (const img of images) {
    if (!img || !ALLOWED_IMAGE_MIME.has(img.mediaType) || typeof img.dataB64 !== "string") {
      return NextResponse.json({ error: "Screenshots must be PNG, JPEG, GIF or WebP" }, { status: 400 });
    }
    if (Math.floor(img.dataB64.length * 0.75) > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Each screenshot must be under 5 MB" }, { status: 400 });
    }
  }

  const result = await buildFormatSkill({
    family: body.family as FormatFamily,
    kindLabel: (body.kindLabel ?? "").slice(0, 100) || "format",
    formatName: body.formatName ?? null,
    answers,
    existing: (body.existing ?? "").slice(0, MAX_EXISTING) || null,
    images,
    fromExamples: body.fromExamples === true,
  });
  if (!result.ok) {
    if (result.failure.reason === "nothing-to-go-on") {
      return NextResponse.json({ error: "Answer at least one question or add a screenshot." }, { status: 400 });
    }
    console.error("build-skill failed", result.failure);
    // No API key on this server (typical on a local checkout) — say so
    // rather than "try again", which never helps.
    if (result.failure.reason === "llm-error" && /authentication|api[_ ]?key/i.test(result.failure.message)) {
      return NextResponse.json({ error: "AI isn't set up on this server (no Anthropic API key)." }, { status: 503 });
    }
    return NextResponse.json({ error: "The AI couldn't write a Skill this time — try again." }, { status: 502 });
  }
  return NextResponse.json({ skill: result.skill, suggestedName: result.suggestedName, look: result.look });
}
