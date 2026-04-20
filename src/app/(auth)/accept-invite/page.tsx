"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInviteInner />
    </Suspense>
  );
}

type ValidationState =
  | { kind: "loading" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; email: string; role: "admin" | "creator" };

function AcceptInviteInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const [validation, setValidation] = useState<ValidationState>({
    kind: "loading",
  });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setValidation({
        kind: "invalid",
        message: "Missing invite token. Open the link from your email.",
      });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/invites/validate?token=${encodeURIComponent(token)}`
        );
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setValidation({
            kind: "invalid",
            message: body.error || "Invalid or expired invite",
          });
          return;
        }
        const body = await res.json();
        setValidation({ kind: "ok", email: body.email, role: body.role });
      } catch {
        if (!cancelled) {
          setValidation({
            kind: "invalid",
            message: "Could not validate invite",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validation.kind !== "ok") return;
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setSubmitting(true);
    const res = await fetch("/api/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password, name }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Failed to accept invite");
      setSubmitting(false);
      return;
    }

    const signInResult = await signIn("credentials", {
      email: validation.email,
      password,
      redirect: false,
    });

    if (!signInResult || signInResult.error) {
      // Account was created; couldn't auto sign-in. Send to login.
      window.location.href = "/login";
      return;
    }
    window.location.href = "/";
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center mx-auto mb-4">
            <span className="text-primary-foreground text-lg font-bold">H</span>
          </div>
          <h1 className="text-xl font-semibold text-foreground">Hub &amp; Spoke</h1>
          <p className="text-sm text-muted-foreground mt-1">Accept your invite</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-6">
          {validation.kind === "loading" && (
            <p className="text-sm text-muted-foreground text-center">
              Checking your invite…
            </p>
          )}

          {validation.kind === "invalid" && (
            <div className="space-y-3 text-center">
              <p className="text-sm text-foreground">{validation.message}</p>
              <p className="text-xs text-muted-foreground">
                <Link href="/login" className="text-primary hover:underline">
                  Back to sign in
                </Link>
              </p>
            </div>
          )}

          {validation.kind === "ok" && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  Email
                </label>
                <input
                  type="email"
                  value={validation.email}
                  readOnly
                  className="w-full h-9 px-3 text-sm rounded-md border border-border bg-muted text-muted-foreground"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="name" className="text-xs font-medium text-foreground">
                  Full name
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full h-9 px-3 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Your name"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="password" className="text-xs font-medium text-foreground">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full h-9 px-3 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Min 8 characters"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="confirm" className="text-xs font-medium text-foreground">
                  Confirm password
                </label>
                <input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  className="w-full h-9 px-3 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Confirm your password"
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <button
                type="submit"
                className="w-full h-9 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                disabled={submitting}
              >
                {submitting ? "Creating account…" : "Accept invite"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
