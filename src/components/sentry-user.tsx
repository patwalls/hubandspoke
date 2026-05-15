"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Mirrors the server-side `setSentrySessionUser` for the browser. The
 * authed layout passes the same `{ id, email, name }` it already reads
 * from the session, and this component stamps it on Sentry's browser
 * scope on mount + whenever the identity changes (e.g. account switch).
 */
export function SentryUser({
  id,
  email,
  name,
}: {
  id: string;
  email: string;
  name: string | null;
}) {
  useEffect(() => {
    Sentry.setUser({ id, email, username: name ?? undefined });
  }, [id, email, name]);
  return null;
}
