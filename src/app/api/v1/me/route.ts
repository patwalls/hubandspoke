import { v1Handler } from "@/lib/api/auth";
import { apiJson } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export const GET = v1Handler("/v1/me", async ({ principal }) => {
  return apiJson({
    data: {
      user: principal.user,
      auth: principal.auth,
      key: principal.key
        ? {
            id: principal.key.id,
            name: principal.key.name,
            prefix: principal.key.keyPrefix,
            created_at: principal.key.createdAt.toISOString(),
          }
        : null,
      rate_limit: {
        limit: principal.rateLimit.limit,
        remaining: principal.rateLimit.remaining,
        reset_at: principal.rateLimit.resetAt,
      },
    },
  });
});
