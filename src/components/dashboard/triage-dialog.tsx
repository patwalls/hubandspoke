"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UserChip } from "./user-chip";
import { KillIdeaDialog } from "./kill-idea-dialog";
import { AcceptIdeaDialog } from "./accept-idea-dialog";
import { renderInstructions } from "@/lib/utils/markdown";
import { todayLocalISO } from "@/lib/utils/dates";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/ui/account-badge";
import type { ProductionItem } from "@/types";

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface PillarRef {
  id: string;
  title: string | null;
  format: string | null;
}

interface RepostedFromRef {
  id: string;
  title: string | null;
  publishedDate: string | null;
  publishedLink: string | null;
  postType: string | null;
  account: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
  } | null;
  views: number | null;
  evergreenReasoning: string | null;
}

interface CrossPostSignals {
  confidence: number | null;
  reasoning: string | null;
  /** Per-age-checkpoint view + ratio on the source item. Sorted 15m → 4h. */
  checkpoints: Array<{
    label: string;
    views: number;
    ratio: number | null;
  }>;
}

interface ItemDetail {
  item: ProductionItem & { notionId?: string | null };
  pillar: PillarRef | null;
  formats: { id: string; name: string; instructions: string | null }[];
  repostedFrom: RepostedFromRef | null;
  crossPostSignals?: CrossPostSignals | null;
}

interface TriageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ProductionItem;
  brand: string;
  users: AssignableUser[];
  onDone: () => void;
}

type RepostActionMode = "idle" | "form";

function showTriageToast(
  status: "Assigned" | "Killed" | "Published",
  extra: Record<string, unknown> | undefined,
  item: ProductionItem,
  brand: string,
  users: AssignableUser[]
) {
  const viewAction = {
    label: "View →",
    onClick: () =>
      window.open(`/${brand}/content/${item.id}`, "_blank", "noopener"),
  };
  const options = { duration: 6000, action: viewAction };

  if (status === "Assigned") {
    const editorId =
      typeof extra?.editorUserId === "string" ? extra.editorUserId : null;
    const editor = editorId ? users.find((u) => u.id === editorId) : null;
    const name = editor?.name || editor?.email || "editor";
    toast.success(`Assigned to ${name}`, options);
    return;
  }
  if (status === "Killed") {
    const title = item.title || "idea";
    toast(`Killed “${title}”`, options);
    return;
  }
  if (status === "Published") {
    const link = typeof extra?.publishedLink === "string" ? extra.publishedLink : "";
    toast.success(
      link ? "Marked as published" : "Marked as scheduled — add link later",
      options
    );
  }
}

export function TriageDialog({
  open,
  onOpenChange,
  item,
  brand,
  users,
  onDone,
}: TriageDialogProps) {
  const isRepost = item.sourceType === "repost";
  const isCrossPost = item.sourceType === "cross_post";
  const isSourced = isRepost || isCrossPost;
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mode, setMode] = useState<RepostActionMode>("idle");
  const [killOpen, setKillOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setSummary(null);
    setSummaryLoading(true);
    setSummaryError(null);
    setActionError(null);
    setMode("idle");
    setKillOpen(false);
    setAcceptOpen(false);

    (async () => {
      try {
        const res = await fetch(`/api/production-items/${item.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ItemDetail;
        if (!cancelled) setDetail(json);
      } catch (err) {
        console.error("Triage detail fetch failed:", err);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();

    // Reposts/cross-posts inherit context from the source — skip the LLM
    // summary to save spend and latency. Originals still get it.
    if (!isSourced) {
      (async () => {
        try {
          const res = await fetch(`/api/production-items/${item.id}/summary`);
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          const json = (await res.json()) as { summary: string | null };
          if (!cancelled) setSummary(json.summary);
        } catch (err) {
          if (!cancelled)
            setSummaryError(
              err instanceof Error ? err.message : "Summary failed"
            );
        } finally {
          if (!cancelled) setSummaryLoading(false);
        }
      })();
    } else {
      setSummaryLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [open, item.id, isSourced]);

  async function updateStatus(
    nextStatus: "Assigned" | "Killed" | "Published",
    extra?: Record<string, unknown>
  ) {
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetch("/api/production-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status: nextStatus, ...extra }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      showTriageToast(nextStatus, extra, item, brand, users);
      onOpenChange(false);
      onDone();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : `Failed to mark ${nextStatus}`
      );
    } finally {
      setSaving(false);
    }
  }

  function assignTo(userId: string) {
    return updateStatus("Assigned", { editorUserId: userId });
  }

  function killIt() {
    setKillOpen(true);
  }

  function acceptIt() {
    setAcceptOpen(true);
  }

  async function confirmKill(reason: string | null) {
    // For cross-post Ideas the kill goes through the outcome route so the
    // reason is mirrored into cross_post_decisions (the LLM's feedback
    // loop). Everything else still goes through the main PUT handler.
    if (isCrossPost && reason && reason.trim().length >= 10) {
      await submitOutcome("kill", reason);
    } else {
      await updateStatus("Killed", { killReason: reason });
    }
    setKillOpen(false);
  }

  async function confirmAccept(reason: string) {
    await submitOutcome("accept", reason);
    setAcceptOpen(false);
  }

  async function submitOutcome(action: "accept" | "kill", reason: string) {
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/production-items/${item.id}/outcome`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, reason }),
        }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const status = action === "accept" ? "Assigned" : "Killed";
      showTriageToast(status, undefined, item, brand, users);
      onOpenChange(false);
      onDone();
    } catch (e) {
      setActionError(
        e instanceof Error
          ? e.message
          : `Failed to ${action === "accept" ? "accept" : "kill"}`
      );
    } finally {
      setSaving(false);
    }
  }

  const pillar = detail?.pillar;
  const repostedFrom = detail?.repostedFrom ?? null;
  const crossPostSignals = detail?.crossPostSignals ?? null;
  const formatInstructions =
    detail && item.format
      ? detail.formats.find((f) => f.name === item.format)?.instructions ?? null
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto gap-5">
        <DialogHeader>
          <div className="flex items-center gap-2 flex-wrap">
            {isRepost && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-900 border border-amber-200"
                title="Reposting an existing piece of content"
              >
                Repost
              </span>
            )}
            {isCrossPost && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-900 border border-indigo-200"
                title="Same content syndicated to a different platform"
              >
                Cross-post
              </span>
            )}
            <AccountBadge
              account={item.account}
              postType={item.postType}
              variant="compact"
            />

            {item.format && !isSourced && (
              <span className="text-xs text-muted-foreground">
                · {item.format}
              </span>
            )}
          </div>
          <DialogTitle className="text-lg font-semibold pr-8">
            {item.title || "(Untitled)"}
          </DialogTitle>
        </DialogHeader>

        {isSourced ? (
          <SourcedBody
            kind={isCrossPost ? "cross_post" : "repost"}
            loading={detailLoading}
            repostedFrom={repostedFrom}
            crossPostSignals={crossPostSignals}
            item={item}
            brand={brand}
            users={users}
            saving={saving}
            mode={mode}
            setMode={setMode}
            actionError={actionError}
            onMarkPublished={(fields) => updateStatus("Published", fields)}
            onAssign={assignTo}
            onKill={killIt}
            onAccept={acceptIt}
          />
        ) : (
          <OriginalBody
            brand={brand}
            detailLoading={detailLoading}
            pillar={pillar ?? null}
            summary={summary}
            summaryLoading={summaryLoading}
            summaryError={summaryError}
            formatInstructions={formatInstructions}
            users={users}
            saving={saving}
            actionError={actionError}
            onAssign={assignTo}
            onKill={killIt}
            itemId={item.id}
          />
        )}
      </DialogContent>
      <KillIdeaDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        title={item.title || ""}
        saving={saving}
        onConfirm={confirmKill}
      />
      <AcceptIdeaDialog
        open={acceptOpen}
        onOpenChange={setAcceptOpen}
        title={item.title || ""}
        saving={saving}
        onConfirm={confirmAccept}
      />
    </Dialog>
  );
}

// ─── Sourced (repost + cross-post) body ──────────────────────────────────
function SourcedBody({
  kind,
  loading,
  repostedFrom,
  crossPostSignals,
  item,
  brand,
  users,
  saving,
  mode,
  setMode,
  actionError,
  onMarkPublished,
  onAssign,
  onKill,
  onAccept,
}: {
  kind: "repost" | "cross_post";
  loading: boolean;
  repostedFrom: RepostedFromRef | null;
  crossPostSignals: CrossPostSignals | null;
  item: ProductionItem;
  brand: string;
  users: AssignableUser[];
  saving: boolean;
  mode: RepostActionMode;
  setMode: (m: RepostActionMode) => void;
  actionError: string | null;
  onMarkPublished: (fields: {
    publishedLink: string;
    publishedDate: string;
  }) => Promise<unknown>;
  onAssign: (userId: string) => Promise<unknown>;
  onKill: () => void;
  onAccept: () => void;
}) {
  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">Loading source post…</p>
    );
  }

  const isCrossPost = kind === "cross_post";
  const sourceAccountLabel = repostedFrom?.account
    ? `@${repostedFrom.account.handle}`
    : "";
  const targetAccountLabel = item.account ? `@${item.account.handle}` : "";
  const isTwitter =
    repostedFrom?.account?.platform === "x" ||
    (repostedFrom?.publishedLink &&
      /^https:\/\/(?:www\.)?(?:twitter|x)\.com\//.test(
        repostedFrom.publishedLink
      ));

  const reasoningLabel = isCrossPost ? "Why cross-post this" : "Why repost this";
  const sourceLabel = isCrossPost ? "Source post" : "Original post";
  const panelStyles = isCrossPost
    ? "bg-indigo-50 border-indigo-200"
    : "bg-amber-50 border-amber-200";

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
      {/* LEFT: context + actions */}
      <div className="md:col-span-5 space-y-4">
        {isCrossPost && (
          <CrossPostReasoningPanel
            reasoningLabel={reasoningLabel}
            panelStyles={panelStyles}
            signals={crossPostSignals}
            sourceChannel={sourceAccountLabel}
            targetChannel={targetAccountLabel}
            sourceViews={repostedFrom?.views ?? null}
          />
        )}
        {!isCrossPost && repostedFrom?.evergreenReasoning && (
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {reasoningLabel}
            </h3>
            <p className={`text-sm text-foreground leading-relaxed ${panelStyles} border rounded-md p-3`}>
              {repostedFrom.evergreenReasoning}
            </p>
          </section>
        )}

        {isCrossPost ? (
          // Cross-post triage: explicit Accept / Kill split with required
          // reasons. Accept flips the Idea to Assigned (feeding the default
          // editor chain); the reason lands in content_events so the LLM
          // feedback loop trains on real operator decisions.
          <section className="space-y-2">
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={onAccept}
                disabled={saving}
                className="inline-flex h-9 items-center justify-center rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Accept this cross-post
              </button>
              {repostedFrom?.publishedLink && (
                <a
                  href={repostedFrom.publishedLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
                >
                  See source post
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              )}
            </div>
            {actionError && (
              <p className="text-[11px] text-red-600">{actionError}</p>
            )}
          </section>
        ) : (
          <>
            <section className="space-y-2">
              {mode === "idle" ? (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setMode("form")}
                    disabled={saving}
                    className="inline-flex h-9 items-center justify-center rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    I posted this ✓
                  </button>
                  {repostedFrom?.publishedLink && (
                    <a
                      href={repostedFrom.publishedLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
                    >
                      See post
                      <ExternalLinkIcon className="size-3.5" />
                    </a>
                  )}
                </div>
              ) : (
                <PostedForm
                  saving={saving}
                  onSubmit={onMarkPublished}
                  onCancel={() => setMode("idle")}
                  defaultChannel={targetAccountLabel || sourceAccountLabel}
                />
              )}
              {actionError && (
                <p className="text-[11px] text-red-600">{actionError}</p>
              )}
            </section>

            {/* Reposts still expose the editor-assign grid because a
            * "repost" Idea can be handed off to someone to actually run. */}
            {mode === "idle" && (
              <section className="space-y-2 border-t border-border pt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Assign editor
                </h3>
                <div className="max-h-40 overflow-y-auto grid grid-cols-2 gap-1">
                  {users.length === 0 ? (
                    <div className="text-xs text-muted-foreground col-span-full">
                      No assignable users found.
                    </div>
                  ) : (
                    users.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => onAssign(u.id)}
                        disabled={saving}
                        className="flex items-center w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                      >
                        <UserChip user={u} size="xs" />
                      </button>
                    ))
                  )}
                </div>
              </section>
            )}
          </>
        )}

        <div className="flex items-center justify-between border-t border-border pt-3">
          <button
            type="button"
            onClick={onKill}
            disabled={saving}
            className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            Kill this idea
          </button>
          <Link
            href={`/${brand}/content/${item.id}`}
            target="_blank"
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            Open full page
            <ExternalLinkIcon className="size-3" />
          </Link>
        </div>
      </div>

      {/* RIGHT: source post */}
      <div className="md:col-span-7 space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {sourceLabel}
          {repostedFrom?.publishedDate && (
            <span className="ml-2 font-normal normal-case tracking-normal text-xs text-muted-foreground">
              from {new Date(repostedFrom.publishedDate).toLocaleDateString(
                "en-US",
                { year: "numeric", month: "short", day: "numeric" }
              )}
              {repostedFrom.views != null && (
                <> · {formatCompact(repostedFrom.views)} views</>
              )}
            </span>
          )}
        </h3>

        {repostedFrom?.publishedLink && isTwitter ? (
          <TweetEmbed url={repostedFrom.publishedLink} />
        ) : repostedFrom?.publishedLink ? (
          <a
            href={repostedFrom.publishedLink}
            target="_blank"
            rel="noopener noreferrer"
            className="block bg-accent/30 border border-border rounded-md p-3 hover:bg-accent transition-colors"
          >
            <div className="text-sm font-medium text-foreground">
              {repostedFrom.title || "(Untitled)"}
            </div>
            <div className="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1">
              {repostedFrom.publishedLink}
              <ExternalLinkIcon className="size-3" />
            </div>
          </a>
        ) : (
          <p className="text-sm text-muted-foreground">
            No published link on the source.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Posted-confirmation form ────────────────────────────────────────────
function PostedForm({
  saving,
  onSubmit,
  onCancel,
  defaultChannel,
}: {
  saving: boolean;
  onSubmit: (fields: {
    publishedLink: string;
    publishedDate: string;
  }) => Promise<unknown>;
  onCancel: () => void;
  defaultChannel: string;
}) {
  const [link, setLink] = useState("");
  const [date, setDate] = useState(() => todayLocalISO());
  const [linkError, setLinkError] = useState<string | null>(null);

  const linkPlaceholder =
    defaultChannel.startsWith("X") || defaultChannel.startsWith("Twitter")
      ? "https://x.com/your-handle/status/…"
      : defaultChannel === "Instagram Reel"
      ? "https://instagram.com/reel/…"
      : "https://…";

  function validateLink(value: string): string | null {
    if (!value.trim()) return "Required";
    if (!/^https:\/\//.test(value.trim())) return "Must start with https://";
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validateLink(link);
    setLinkError(err);
    if (err) return;
    await onSubmit({
      publishedLink: link.trim(),
      publishedDate: date,
    });
  }

  async function handleScheduled() {
    setLinkError(null);
    await onSubmit({ publishedLink: "", publishedDate: date });
  }

  const canSubmit = !saving && !!link.trim() && !!date;
  const canSchedule = !saving && !!date;

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Post details
      </h3>

      <div className="space-y-1">
        <label
          htmlFor="posted-link"
          className="block text-xs font-medium text-foreground"
        >
          Published link <span className="text-red-600">*</span>
        </label>
        <input
          id="posted-link"
          type="url"
          required
          autoFocus
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            if (linkError) setLinkError(validateLink(e.target.value));
          }}
          placeholder={linkPlaceholder}
          className="w-full rounded-md border border-input bg-background px-2.5 h-9 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {linkError && <p className="text-[11px] text-red-600">{linkError}</p>}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="posted-date"
          className="block text-xs font-medium text-foreground"
        >
          Published date <span className="text-red-600">*</span>
        </label>
        <input
          id="posted-date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-input bg-background px-2.5 h-9 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex h-9 items-center justify-center rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Mark posted"}
        </button>
        <button
          type="button"
          onClick={handleScheduled}
          disabled={!canSchedule}
          title="Mark published with no link — someone can fill it in later"
          className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
        >
          Scheduled
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Original (non-repost) body ──────────────────────────────────────────
function OriginalBody({
  brand,
  detailLoading,
  pillar,
  summary,
  summaryLoading,
  summaryError,
  formatInstructions,
  users,
  saving,
  actionError,
  onAssign,
  onKill,
  itemId,
}: {
  brand: string;
  detailLoading: boolean;
  pillar: PillarRef | null;
  summary: string | null;
  summaryLoading: boolean;
  summaryError: string | null;
  formatInstructions: string | null;
  users: AssignableUser[];
  saving: boolean;
  actionError: string | null;
  onAssign: (userId: string) => Promise<unknown>;
  onKill: () => void;
  itemId: string;
}) {
  return (
    <>
      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Pillar content
        </h3>
        {detailLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : pillar ? (
          <Link
            href={`/${brand}/content/${pillar.id}`}
            target="_blank"
            className="inline-flex items-center gap-1.5 text-sm text-foreground hover:text-primary hover:underline"
          >
            {pillar.title || "(Untitled)"}
            {pillar.format && (
              <span className="text-xs text-muted-foreground">
                · {pillar.format}
              </span>
            )}
            <ExternalLinkIcon className="size-3 text-muted-foreground" />
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">No pillar linked.</p>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Summary
        </h3>
        {summaryLoading ? (
          <p className="text-sm text-muted-foreground">Generating…</p>
        ) : summaryError ? (
          <p className="text-sm text-red-600">
            Couldn&apos;t generate a summary.
          </p>
        ) : summary ? (
          <p className="text-sm text-foreground leading-relaxed bg-accent/30 rounded-md p-3">
            {summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">(empty)</p>
        )}
      </section>

      {formatInstructions && (
        <section className="space-y-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Format skill
          </h3>
          <div className="whitespace-pre-wrap break-words text-xs text-foreground bg-accent/30 rounded-md p-3 max-h-60 overflow-auto leading-relaxed">
            {renderInstructions(formatInstructions)}
          </div>
        </section>
      )}

      <section className="space-y-2 border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Assign editor
        </h3>
        <div className="max-h-56 overflow-y-auto grid grid-cols-2 lg:grid-cols-3 gap-1">
          {users.length === 0 ? (
            <div className="text-xs text-muted-foreground col-span-full">
              No assignable users found.
            </div>
          ) : (
            users.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => onAssign(u.id)}
                disabled={saving}
                className="flex items-center w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                <UserChip user={u} size="xs" />
              </button>
            ))
          )}
        </div>

        {actionError && (
          <p className="text-[11px] text-red-600">{actionError}</p>
        )}

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={onKill}
            disabled={saving}
            className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            Kill this idea
          </button>
          <Link
            href={`/${brand}/content/${itemId}`}
            target="_blank"
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            Open full page
            <ExternalLinkIcon className="size-3" />
          </Link>
        </div>
      </section>
    </>
  );
}

// ─── Tweet embed ─────────────────────────────────────────────────────────
declare global {
  interface Window {
    twttr?: {
      widgets: {
        createTweet: (
          id: string,
          container: HTMLElement,
          options?: Record<string, unknown>
        ) => Promise<HTMLElement | undefined>;
      };
    };
  }
}

function extractTweetId(url: string): string | null {
  const match = url.match(/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/);
  return match?.[1] ?? null;
}

let widgetsScriptPromise: Promise<void> | null = null;

function loadWidgetsScript(): Promise<void> {
  if (widgetsScriptPromise) return widgetsScriptPromise;
  widgetsScriptPromise = new Promise((resolve, reject) => {
    if (window.twttr?.widgets) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://platform.twitter.com/widgets.js"]'
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("widgets.js failed")),
        { once: true }
      );
      return;
    }
    const s = document.createElement("script");
    s.src = "https://platform.twitter.com/widgets.js";
    s.async = true;
    s.charset = "utf-8";
    s.addEventListener("load", () => resolve(), { once: true });
    s.addEventListener(
      "error",
      () => reject(new Error("widgets.js failed")),
      { once: true }
    );
    document.body.appendChild(s);
  });
  return widgetsScriptPromise;
}

function TweetEmbed({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading"
  );
  const tweetId = extractTweetId(url);

  useEffect(() => {
    if (!tweetId) {
      setStatus("failed");
      return;
    }
    let cancelled = false;
    setStatus("loading");

    function render() {
      if (cancelled || !containerRef.current || !window.twttr?.widgets) return;
      containerRef.current.innerHTML = "";
      window.twttr.widgets
        .createTweet(tweetId!, containerRef.current, {
          conversation: "none",
          dnt: "true",
        })
        .then((embed) => {
          if (cancelled) return;
          setStatus(embed ? "ready" : "failed");
        })
        .catch(() => {
          if (!cancelled) setStatus("failed");
        });
    }

    loadWidgetsScript()
      .then(render)
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [tweetId]);

  if (status === "failed") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block bg-accent/30 border border-border rounded-md p-3 hover:bg-accent transition-colors"
      >
        <div className="text-sm font-medium text-foreground inline-flex items-center gap-1.5">
          See post on X
          <ExternalLinkIcon className="size-3.5" />
        </div>
        <div className="text-xs text-muted-foreground mt-1 break-all">
          {url}
        </div>
      </a>
    );
  }

  return (
    <div className="bg-accent/20 border border-border rounded-md p-2 min-h-[120px]">
      <div ref={containerRef} />
      {status === "loading" && (
        <p className="text-xs text-muted-foreground px-2 py-1">
          Loading tweet…
        </p>
      )}
    </div>
  );
}

// Cross-post-specific reasoning block. Prefers the v2 scanner's signals
// (LLM reasoning + velocity + confidence) when present; falls back to the
// hardcoded "Source ran on X" sentence for legacy cross-post rows created
// before the v2 scanner landed.
function CrossPostReasoningPanel({
  reasoningLabel,
  panelStyles,
  signals,
  sourceChannel,
  targetChannel,
  sourceViews,
}: {
  reasoningLabel: string;
  panelStyles: string;
  signals: CrossPostSignals | null;
  sourceChannel: string;
  targetChannel: string;
  sourceViews: number | null;
}) {
  const hasV2Reasoning =
    !!signals?.reasoning && signals.reasoning.trim().length > 0;
  const checkpoints = signals?.checkpoints ?? [];
  const hasCheckpoints = checkpoints.length > 0;
  const hasConfidence = signals?.confidence != null;

  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {reasoningLabel}
      </h3>

      {hasConfidence && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "inline-flex items-center rounded px-1.5 py-0.5 font-medium",
              signals!.confidence! >= 85
                ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                : signals!.confidence! >= 70
                ? "bg-amber-100 text-amber-900 border border-amber-200"
                : "bg-muted text-muted-foreground border border-border"
            )}
          >
            {signals!.confidence}% confidence
          </span>
        </div>
      )}

      {hasCheckpoints && (
        <div className="rounded-md border border-border bg-muted/30 p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Velocity after publish
          </div>
          <table className="w-full text-[11px] text-foreground">
            <tbody>
              {checkpoints.map((cp) => (
                <tr key={cp.label}>
                  <td className="pr-3 text-muted-foreground tabular-nums w-10">
                    {cp.label}
                  </td>
                  <td className="pr-3 tabular-nums text-right w-20">
                    {formatCompact(cp.views)}
                  </td>
                  <td className="text-muted-foreground tabular-nums">
                    {cp.ratio != null ? (
                      <span
                        className={cn(
                          cp.ratio >= 2 ? "text-emerald-700" : "",
                          cp.ratio >= 4 ? "font-semibold" : ""
                        )}
                      >
                        {cp.ratio.toFixed(1)}× baseline
                      </span>
                    ) : (
                      <span className="text-muted-foreground/70">
                        no baseline yet
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p
        className={`text-sm text-foreground leading-relaxed ${panelStyles} border rounded-md p-3`}
      >
        {hasV2Reasoning ? (
          signals!.reasoning
        ) : sourceChannel && targetChannel ? (
          <>
            Source ran on <span className="font-medium">{sourceChannel}</span>
            {sourceViews != null && (
              <> and hit {formatCompact(sourceViews)} views</>
            )}
            . Re-post on <span className="font-medium">{targetChannel}</span>{" "}
            with light tweaks for the platform.
          </>
        ) : (
          "Legacy cross-post — no scanner reasoning captured."
        )}
      </p>
    </section>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}
