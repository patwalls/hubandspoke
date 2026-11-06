"use client";

// The Formats tab's one way to make a format. The menu lists platforms
// (Pillar, Instagram, YouTube, X, LinkedIn, Newsletter); picking one opens
// a dialog that, for platforms with both, asks Clip or Post first, then how
// to start (a proven format from another brand, an AI draft from a
// description + screenshots, or a blank starter), then only the fields that
// kind needs. The technical settings (clippable, clip target, aspect,
// labels-as-original, the channel's post type) come from the kind
// (src/lib/format-kinds.ts) — nobody has to know they exist. Replaces the
// old From Library / Quick Add (AI) / Create Manually trio.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { useCanEditBrand } from "@/components/brand-access";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";
import { POST_TYPE_SHORT_LABEL } from "@/lib/platforms";
import { cn } from "@/lib/utils";
import {
  FORMAT_PLATFORMS,
  formatKindSettings,
  formatPlatform,
} from "@/lib/format-kinds";
import { SkillGuideEditor } from "./skill-guide-editor";

// ── Drafts ──────────────────────────────────────────────────────────────
// Per browser (localStorage), per brand + platform (+ preset parent): a
// convenience so an unfinished format survives closing the dialog. Every
// access is guarded — storage can be missing or blocked.

interface FormatDraft {
  kindKey: string;
  name: string;
  parentId: string;
  pickedAccountIds: string[];
  viewThreshold: string;
  instructions: string;
}

function draftKey(brand: string, platformKey: string, parentId: string | null): string {
  return `add-format-draft:${brand}:${platformKey}:${parentId ?? ""}`;
}

function readDraft(key: string): FormatDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as FormatDraft) : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: FormatDraft) {
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // storage unavailable — the draft just isn't kept
  }
}

function clearDraft(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// ── Menu ────────────────────────────────────────────────────────────────

/** The "Add format" button + platform menu + dialog. On the detail page it
 *  is "Add derivative": `parentFormatId` presets the pillar and the Pillar
 *  row is hidden. */
export function AddFormatMenu({
  brand,
  parentFormatId = null,
  label = "Add format",
  size = "default",
}: {
  brand: string;
  parentFormatId?: string | null;
  label?: string;
  size?: "default" | "sm";
}) {
  const [open, setOpen] = useState<string | null>(null);
  // A derivative can't be a pillar.
  const pillar = parentFormatId ? null : FORMAT_PLATFORMS.find((p) => p.key === "pillar") ?? null;
  const rest = FORMAT_PLATFORMS.filter((p) => p.key !== "pillar");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="add-format"
          className={cn(
            "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-primary font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            size === "sm" ? "h-8 px-3 text-xs" : "px-4 py-2 text-sm w-full sm:w-auto",
          )}
        >
          <Plus className="size-4" />
          {label}
          <ChevronDown className="ml-0.5 size-4 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-72">
          {pillar && (
            <>
              <DropdownMenuItem
                onClick={() => setOpen(pillar.key)}
                className="cursor-pointer gap-2"
                data-testid="add-format-pillar"
              >
                <PlatformIcon platform={pillar.icon} size={15} inheritColor className="text-muted-foreground" />
                <span className="flex flex-col">
                  <span>Pillar</span>
                  <span className="whitespace-nowrap text-[11px] text-muted-foreground">The long video everything comes from</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuGroup>
            {rest.map((p) => (
              <DropdownMenuItem
                key={p.key}
                onClick={() => !p.comingSoon && setOpen(p.key)}
                disabled={p.comingSoon}
                className="cursor-pointer gap-2"
                data-testid={`add-format-${p.key}`}
              >
                <PlatformIcon platform={p.icon} size={15} inheritColor className="text-muted-foreground" />
                <span className="flex-1">{p.label}</span>
                {p.comingSoon ? (
                  <span className="whitespace-nowrap text-[11px] text-muted-foreground">Coming soon</span>
                ) : readDraft(draftKey(brand, p.key, parentFormatId)) ? (
                  <span className="whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    Draft
                  </span>
                ) : (
                  p.kinds.length > 1 && (
                    <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                      {p.kinds.map((k) => k.toggleLabel).join(" · ")}
                    </span>
                  )
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && (
        <AddFormatDialog
          key={open}
          brand={brand}
          platformKey={open}
          presetParentId={parentFormatId}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

// ── Dialog ──────────────────────────────────────────────────────────────

interface BrandFormat {
  id: string;
  name: string;
  parentFormatId: string | null;
}

interface Account {
  id: string;
  platform: string;
  handle: string;
  isActive: boolean;
}

interface LibraryFormat {
  id: string;
  name: string;
  brandLabel: string;
  instructions: string | null;
  isClippableFormat: boolean;
  postTypes: string[];
  examples: { title: string | null; views: number | null }[];
  provenStatus: { isProven: boolean; reason: "proven" | "testing" | "stale" } | null;
}

type Start = "create" | "library";

const START_OPTIONS: { key: Start; label: string }[] = [
  { key: "create", label: "Create" },
  { key: "library", label: "Copy a proven one" },
];

function compactViews(v: number | null): string {
  if (!v) return "";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M views`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K views`;
  return `${v} views`;
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  testId,
}: {
  options: { key: T; label: string; sub?: string }[];
  value: T;
  onChange: (v: T) => void;
  testId?: string;
}) {
  return (
    <div className="grid gap-1 rounded-lg bg-muted p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          data-testid={testId ? `${testId}-${o.key}` : undefined}
          aria-pressed={value === o.key}
          className={cn(
            "rounded-md px-2 py-1.5 text-sm transition-colors",
            value === o.key
              ? "bg-primary font-medium text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
          )}
        >
          <span className="block">{o.label}</span>
          {o.sub && (
            <span className={cn("block text-[11px] font-normal", value === o.key ? "text-primary-foreground/80" : "text-muted-foreground")}>
              {o.sub}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** An existing format opened for editing ("Edit format" on its page). */
export interface EditingFormat {
  id: string;
  kindKey: string;
  name: string;
  parentId: string | null;
  accountId: string | null;
  /** How many accounts it posts to today — the guided view keeps one. */
  channelCount: number;
  viewThreshold: number | null;
  instructions: string;
}

export function AddFormatDialog({
  brand,
  platformKey,
  presetParentId,
  onClose,
  editing = null,
  onSaved,
}: {
  brand: string;
  platformKey: string;
  presetParentId?: string | null;
  onClose: () => void;
  editing?: EditingFormat | null;
  /** Edit mode: called after a save; `design` = the user asked to go on to
   *  the designer. */
  onSaved?: (design: boolean) => void;
}) {
  const router = useRouter();
  const canEdit = useCanEditBrand(brand);
  const flags = useFeatureFlags();
  const platform = formatPlatform(platformKey)!;
  const [kindKey, setKindKey] = useState(
    () =>
      editing?.kindKey ??
      readDraft(draftKey(brand, platformKey, presetParentId ?? null))?.kindKey ??
      platform.kinds[0].key,
  );
  const kind = platform.kinds.find((k) => k.key === kindKey) ?? platform.kinds[0];

  // A draft saved earlier for this platform (Save draft, or clicking out)
  // comes back where it was left.
  const key = draftKey(brand, platformKey, presetParentId ?? null);
  // Editing never reads or writes a create-draft.
  const [restored] = useState(() =>
    editing
      ? {
          kindKey: editing.kindKey,
          name: editing.name,
          parentId: editing.parentId ?? "",
          pickedAccountIds: editing.accountId ? [editing.accountId] : [],
          viewThreshold: editing.viewThreshold != null ? String(editing.viewThreshold) : "",
          instructions: editing.instructions,
        }
      : readDraft(key),
  );
  const [start, setStart] = useState<Start>("create");
  const [name, setName] = useState(restored?.name ?? "");
  const [parentId, setParentId] = useState(restored?.parentId ?? presetParentId ?? "");
  const [pickedAccountIds, setPickedAccountIds] = useState<string[]>(restored?.pickedAccountIds ?? []);
  const [viewThreshold, setViewThreshold] = useState(restored?.viewThreshold ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [instructions, setInstructions] = useState(restored?.instructions ?? "");
  const [showRestored, setShowRestored] = useState(!!restored && !editing);

  const [brandFormats, setBrandFormats] = useState<BrandFormat[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [library, setLibrary] = useState<LibraryFormat[] | null>(null);
  const [pickedLibraryId, setPickedLibraryId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch(`/api/formats?brand=${encodeURIComponent(brand)}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/accounts?brand=${encodeURIComponent(brand)}`).then((r) => (r.ok ? r.json() : { accounts: [] })),
    ]).then(([fmts, accts]) => {
      if (cancelled) return;
      setBrandFormats(Array.isArray(fmts) ? fmts : []);
      setAccounts(accts?.accounts ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [brand]);

  // Keep the draft in step with the form, so clicking out never loses work.
  useEffect(() => {
    const hasWork = !!(name.trim() || instructions.trim() || viewThreshold.trim());
    if (hasWork && !editing) writeDraft(key, { kindKey, name, parentId, pickedAccountIds, viewThreshold, instructions });
  }, [editing, key, kindKey, name, parentId, pickedAccountIds, viewThreshold, instructions]);

  function discardDraft() {
    clearDraft(key);
    setName("");
    setParentId(presetParentId ?? "");
    setPickedAccountIds([]);
    setViewThreshold("");
    setInstructions("");
    setShowRestored(false);
  }

  // Library loads the first time it's asked for.
  useEffect(() => {
    if (start !== "library" || library !== null) return;
    let cancelled = false;
    void fetch(`/api/format-library?exclude=${encodeURIComponent(brand)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => !cancelled && setLibrary(Array.isArray(rows) ? rows : []));
    return () => {
      cancelled = true;
    };
  }, [start, library, brand]);

  const platformAccounts = (accounts ?? []).filter((a) => a.isActive && a.platform === kind.accountPlatform);
  // One account on the platform → it's the obvious pick; picks from the
  // other Type's platform don't carry over.
  const selectedAccountIds =
    platformAccounts.length === 1
      ? [platformAccounts[0].id]
      : pickedAccountIds.filter((id) => platformAccounts.some((a) => a.id === id)).slice(0, 1);
  // What the channel row calls this kind's post ("Short", "Reel", "Video"…).
  const postTypeLabel =
    kind.family === "clip" && POST_TYPE_SHORT_LABEL[kind.postType] === "Post"
      ? "Video"
      : POST_TYPE_SHORT_LABEL[kind.postType];
  // One account per format: posts (and clip ideas) go to exactly one place.
  // Reposting elsewhere is a cross-post from the post's page.
  function pickAccount(id: string) {
    setPickedAccountIds([id]);
  }

  // Only pillars — plus the preset parent when "Add derivative" was opened
  // from a non-pillar format.
  const pillars = (brandFormats ?? []).filter(
    (f) => f.id !== editing?.id && (!f.parentFormatId || f.id === presetParentId || f.id === editing?.parentId),
  );

  const sharedPostType = new Set(platform.kinds.map((k) => k.postType)).size < platform.kinds.length;
  const libraryForKind = (() => {
    const rank = (f: LibraryFormat) =>
      f.provenStatus?.isProven ? 2 : f.provenStatus?.reason === "testing" ? 1 : 0;
    return (library ?? [])
      .filter((f) => f.postTypes.includes(kind.postType))
      // Where clip and carousel share a post type (X, LinkedIn, Threads,
      // Facebook), tell them apart by the clippable flag.
      .filter((f) => !sharedPostType || f.isClippableFormat === kind.isClippableFormat)
      .sort((a, b) => rank(b) - rank(a) || (b.examples[0]?.views ?? 0) - (a.examples[0]?.views ?? 0));
  })();

  function changeKind(next: string) {
    setKindKey(next);
    setPickedLibraryId(null);
  }

  function changeStart(next: Start) {
    setStart(next);
    setError(null);
  }

  function pickLibrary(f: LibraryFormat) {
    setPickedLibraryId(f.id);
    setName(f.name);
    setInstructions(f.instructions ?? "");
  }

  const needsAccount = platformAccounts.length > 0;
  const missing: string[] = [];
  if (!name.trim()) missing.push("a name");
  if (kind.parent === "required" && !parentId) missing.push("the pillar it comes from");
  if (needsAccount && selectedAccountIds.length === 0) missing.push("the account it posts to");
  const ready = canEdit && missing.length === 0 && !saving;
  // "Next: design format" — save, then open this kind's designer (clip look /
  // design template) on the new format's page. Only for kinds that have one
  // and users who have that editor's flag.
  const designsNext =
    (kind.designer === "clip" && !!flags?.clipEditor) || (kind.designer === "design" && !!flags?.designEditor);

  async function saveEdit(design: boolean) {
    if (!ready || !editing) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/formats", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editing.id,
          name: name.trim(),
          parentFormatId: kind.parent === "none" ? null : parentId || null,
          accountChannels: selectedAccountIds.map((accountId) => ({ accountId, postType: kind.postType })),
          viewThreshold: viewThreshold ? parseInt(viewThreshold, 10) : null,
          instructions: instructions.trim() || null,
          // Only a Type change rewrites the fixed settings — otherwise a
          // shape picked in the clip look (say vertical on X) is kept.
          ...(kind.key !== editing.kindKey ? formatKindSettings(kind) : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      toast.success("Format saved");
      onSaved?.(design);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  async function create() {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/formats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          brand,
          parentFormatId: kind.parent === "none" ? null : parentId || null,
          accountChannels: selectedAccountIds.map((accountId) => ({ accountId, postType: kind.postType })),
          viewThreshold: viewThreshold ? parseInt(viewThreshold, 10) : null,
          instructions: instructions.trim() || null,
          ...formatKindSettings(kind),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.id) throw new Error(json?.error ?? `HTTP ${res.status}`);
      clearDraft(key);
      onClose();
      router.push(
        `/${brand}/formats/${json.id}?new=${encodeURIComponent(kind.key)}${designsNext ? "&design=1" : ""}`,
      );
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const field = "h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm";
  const showLibraryList = start === "library" && !pickedLibraryId;

  const autoSettings: string[] = [];
  if (kind.isClippableFormat) autoSettings.push("Clip ideas generated ✓", `Posts as ${kind.label}`, kind.clipAspectRatio ?? "");
  if (kind.labelsAsOriginal) autoSettings.push("Marked as original content ✓");
  if (kind.family === "design" || kind.family === "newsletter") autoSettings.push(`Posts as ${kind.label}`);

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-xl">
        <div className="flex items-center gap-3 border-b px-5 py-4 pr-12">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
            <PlatformIcon platform={platform.icon} size={18} inheritColor className="text-foreground" />
          </div>
          <div className="flex min-w-0 flex-col">
            <DialogTitle className="text-base font-semibold leading-snug">
              {editing ? `Edit ${editing.name}` : `New ${platform.kinds.length > 1 ? platform.label : kind.label} format`}
            </DialogTitle>
            <span className="text-xs text-muted-foreground">{kind.editorLine}</span>
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
          {showRestored && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs" data-testid="add-format-draft-restored">
              <span>Picked up your saved draft.</span>
              <button type="button" onClick={discardDraft} className="text-muted-foreground hover:text-foreground hover:underline">
                Discard draft
              </button>
            </div>
          )}
          {platform.kinds.length > 1 && (
            <Field label="Type">
              <SegmentedControl
                options={platform.kinds.map((k) => ({ key: k.key, label: k.toggleLabel, sub: k.label }))}
                value={kind.key}
                onChange={changeKind}
                testId="add-format-type"
              />
            </Field>
          )}

          {!editing && (
            <Field label="Start from">
              <SegmentedControl options={START_OPTIONS} value={start} onChange={changeStart} testId="add-format-start" />
            </Field>
          )}

          {showLibraryList && (
            <div className="flex flex-col gap-1.5" data-testid="add-format-library">
              <span className="text-xs text-muted-foreground">
                Top {kind.label} formats from other brands — pick one to copy its Skill.
              </span>
              {library === null ? (
                <span className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
                </span>
              ) : libraryForKind.length === 0 ? (
                <span className="text-xs text-muted-foreground">
                  No {kind.label} formats in other brands yet — try Describe it or Start from scratch.
                </span>
              ) : (
                <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                  {libraryForKind.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => pickLibrary(f)}
                      className="flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left hover:bg-accent"
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="truncate text-sm font-medium">{f.name}</span>
                        <span className="text-[11px] text-muted-foreground">{f.brandLabel}</span>
                        {f.provenStatus?.isProven && (
                          <span className="ml-auto rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                            Proven
                          </span>
                        )}
                      </span>
                      {f.examples[0]?.title && (
                        <span className="w-full truncate text-xs text-muted-foreground">
                          Top post: {f.examples[0].title}
                          {f.examples[0].views ? ` · ${compactViews(f.examples[0].views)}` : ""}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {start === "library" && pickedLibraryId && (
            <button
              type="button"
              onClick={() => setPickedLibraryId(null)}
              className="self-start text-xs text-primary hover:underline"
            >
              ← Pick a different one
            </button>
          )}

          {!showLibraryList && (
            <>
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={kind.family === "pillar" ? "e.g. Business Breakdown" : "e.g. Tech Stack Reveal"}
                  data-testid="add-format-name"
                />
              </Field>

              {kind.parent !== "none" && (
                <Field
                  label={kind.parent === "required" ? "Comes from which pillar?" : "Comes from which pillar? (optional)"}
                  hint="New posts in this format are made from that pillar's videos."
                >
                  {brandFormats === null ? (
                    <span className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" /> Loading…
                    </span>
                  ) : (
                    <select
                      className={field}
                      value={parentId}
                      onChange={(e) => setParentId(e.target.value)}
                      data-testid="add-format-parent"
                    >
                      <option value="">{kind.parent === "required" ? "Pick a pillar…" : "None"}</option>
                      {pillars.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  )}
                </Field>
              )}

              <Field
                label="Where it posts"
                hint={`Pick one account — every post in this format goes there (${kind.label}). To share a post on another account too, use Cross-post on the post's page.`}
              >
                {accounts === null ? (
                  <span className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Loading…
                  </span>
                ) : platformAccounts.length === 0 ? (
                  <span className="text-xs text-amber-700">
                    This brand has no {platform.key === "pillar" ? "YouTube" : platform.label} account yet. You can
                    create the format now and add the account on its page later.
                  </span>
                ) : (
                  <>
                  {editing && editing.channelCount > 1 && (
                    <p className="text-[11px] text-amber-700">
                      This format posts to {editing.channelCount} accounts today. Saving here keeps only the one picked —
                      to keep them all, edit on the format page instead.
                    </p>
                  )}
                  <div className="flex flex-col overflow-hidden rounded-lg border" data-testid="add-format-account">
                    {platformAccounts.map((a) => {
                      const checked = selectedAccountIds.includes(a.id);
                      return (
                        <label
                          key={a.id}
                          className={cn(
                            "flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 last:border-b-0 hover:bg-accent/60",
                            checked && "bg-accent/40",
                          )}
                        >
                          <input
                            type="radio"
                            name="add-format-account"
                            checked={checked}
                            onChange={() => pickAccount(a.id)}
                            className="size-4 accent-[var(--primary)]"
                            data-testid={`add-format-account-${a.handle}`}
                          />
                          <PlatformIcon platform={a.platform} size={16} />
                          <span className="flex-1 truncate text-sm">@{a.handle}</span>
                          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {postTypeLabel}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  </>
                )}
              </Field>


              <Field label="Skill — how the AI makes posts in this format">
                <SkillGuideEditor
                  value={instructions}
                  onChange={setInstructions}
                  family={kind.family}
                  brand={brand}
                  kindLabel={kind.label}
                  formatName={name}
                  onSuggestName={(n) => setName((cur) => cur.trim() ? cur : n)}
                  rows={10}
                  textareaClassName="max-h-72"
                  testId="add-format-skill"
                />
              </Field>

              {kind.showsViewThreshold && (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setAdvancedOpen((v) => !v)}
                    className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
                  >
                    <ChevronDown className={cn("size-3 transition-transform", advancedOpen && "rotate-180")} />
                    Advanced
                  </button>
                  {advancedOpen && (
                    <Field
                      label="View threshold"
                      hint="When a pillar video passes this many views, a task to make one of these is created automatically."
                    >
                      <Input
                        type="number"
                        value={viewThreshold}
                        onChange={(e) => setViewThreshold(e.target.value)}
                        placeholder="e.g. 50000"
                      />
                    </Field>
                  )}
                </div>
              )}

              {autoSettings.length > 0 && (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
                  Set up for you: {autoSettings.filter(Boolean).join(" · ")}
                </p>
              )}
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {missing.length > 0 && !showLibraryList ? `Still needs ${missing.join(", ")}` : ""}
          </span>
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
                  Cancel
                </Button>
                {designsNext && (
                  <Button size="sm" variant="outline" onClick={() => void saveEdit(true)} disabled={!ready} data-testid="edit-format-save-design">
                    Save &amp; edit design →
                  </Button>
                )}
                <Button size="sm" onClick={() => void saveEdit(false)} disabled={!ready} data-testid="edit-format-save">
                  {saving ? <Loader2 className="animate-spin" /> : null}
                  Save changes
                </Button>
              </>
            ) : (
              <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (name.trim() || instructions.trim() || viewThreshold.trim()) {
                    writeDraft(key, { kindKey, name, parentId, pickedAccountIds, viewThreshold, instructions });
                    toast.success("Draft saved — pick this platform again to pick up where you left off");
                  }
                  onClose();
                }}
                disabled={saving}
                data-testid="add-format-save-draft"
              >
                Save draft
              </Button>
              <Button size="sm" onClick={() => void create()} disabled={!ready || showLibraryList} data-testid="add-format-create">
                {saving ? <Loader2 className="animate-spin" /> : designsNext ? null : <Plus />}
                {designsNext ? "Next: design format →" : "Create format"}
              </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
