import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { generateUtmCampaign } from "@/lib/utm-campaign";

/**
 * POST /api/production-items/generate-utm
 *
 * Returns a fresh, collision-checked UTM campaign slug seeded from the
 * supplied title. Used by the Add-Post dialog so operators can grab the
 * UTM (and paste it into the published link) before the row is created.
 *
 * Body: { title?: string }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let title: string | null = null;
  try {
    const body = await request.json();
    if (typeof body?.title === "string") title = body.title;
  } catch {
    // No body / not JSON — fall through with title=null; generator handles it.
  }

  const utmCampaign = await generateUtmCampaign(title);
  return NextResponse.json({ utmCampaign });
}
