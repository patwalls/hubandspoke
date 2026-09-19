import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { formatsWithDesignTemplate } from "@/lib/services/design-editor/format-template";

/** `?brand=` → the format names the design editor can draft for. Feeds the
 *  queue dialogs' "open the designer or the classic view?" decision. */
export async function GET(request: NextRequest) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand") ?? "starter-story";
  return NextResponse.json({ brand, formats: await formatsWithDesignTemplate(brand) });
}
