import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import { getBrands, invalidateBrandCache } from "@/lib/db/brands";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await getBrands();
  return NextResponse.json({ brands: rows });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { slug, label, avatarUrl, color, disabled } = body as {
      slug?: string;
      label?: string;
      avatarUrl?: string | null;
      color?: string | null;
      disabled?: boolean;
    };
    if (!slug?.trim() || !label?.trim()) {
      return NextResponse.json(
        { error: "slug and label are required" },
        { status: 400 }
      );
    }
    // Normalize slug: lowercase + dashed, strip spaces / funky chars. Keeps
    // routes (`/<slug>/…`) readable.
    const cleanSlug = slug
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (!cleanSlug) {
      return NextResponse.json({ error: "slug is invalid" }, { status: 400 });
    }

    const [row] = await db
      .insert(brands)
      .values({
        slug: cleanSlug,
        label: label.trim(),
        avatarUrl: avatarUrl ?? null,
        color: color ?? null,
        disabled: disabled ?? false,
      })
      .onConflictDoNothing({ target: brands.slug })
      .returning();

    if (!row) {
      return NextResponse.json(
        { error: `Brand ${cleanSlug} already exists` },
        { status: 409 }
      );
    }

    invalidateBrandCache();
    return NextResponse.json({ brand: row });
  } catch (error) {
    console.error("Error creating brand:", error);
    return NextResponse.json(
      { error: "Failed to create brand" },
      { status: 500 }
    );
  }
}
