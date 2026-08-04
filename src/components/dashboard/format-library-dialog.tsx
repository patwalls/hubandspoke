"use client";

import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
  BookOpenIcon,
  CheckIcon,
  ExternalLinkIcon,
  PlayCircleIcon,
  EyeIcon,
  XIcon,
  ScissorsIcon,
  FileTextIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { POST_TYPE_LABELS } from "@/lib/badge-colors";

interface FormatExample {
  title: string | null;
  views: number | null;
  postType: string | null;
  contentMediaUrl: string | null;
  // null when no URL is stored (e.g. X posts synced from the platform API).
  // Row is rendered non-clickable in that case.
  url: string | null;
}

interface ProvenStatus {
  isProven: boolean;
  reason: "proven" | "testing" | "stale";
}

interface LibraryFormat {
  id: string;
  name: string;
  brand: string;
  brandLabel: string;
  instructions: string | null;
  parentFormatId: string | null;
  parentName: string | null;
  isClippableFormat: boolean;
  isCanvaFormat: boolean;
  labelsAsOriginal: boolean;
  clipTargetPostType: string | null;
  clipAspectRatio: string | null;
  viewThreshold: number | null;
  postTypes: string[];
  examples: FormatExample[];
  provenStatus: ProvenStatus | null;
}

interface DestFormat {
  id: string;
  name: string;
  parentFormatId: string | null;
}

interface CardState {
  status: "idle" | "loading" | "added" | "error";
  error?: string;
  selectedParentId?: string;
  previewing?: boolean;
}

interface Props {
  brand: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: () => void;
}

function formatViews(views: number | null): string {
  if (!views || views === 0) return "";
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M views`;
  if (views >= 1_000) return `${Math.round(views / 1_000)}K views`;
  return `${views.toLocaleString()} views`;
}

function PlatformBadges({ postTypes }: { postTypes: string[] }) {
  if (postTypes.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {postTypes.map((pt) => (
        <span
          key={pt}
          className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground border border-border"
        >
          {POST_TYPE_LABELS[pt] ?? pt}
        </span>
      ))}
    </div>
  );
}

function ExampleRow({ ex }: { ex: FormatExample }) {
  const inner = (
    <>
      {ex.contentMediaUrl ? (
        <img
          src={ex.contentMediaUrl}
          alt=""
          className="size-7 rounded object-cover shrink-0 bg-muted"
        />
      ) : (
        <div className="size-7 rounded bg-muted flex items-center justify-center shrink-0">
          <PlayCircleIcon className="size-3.5 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {ex.title && (
            <span className="text-xs text-foreground truncate max-w-[260px]">{ex.title}</span>
          )}
          {ex.views !== null && ex.views > 0 && (
            <span className="text-[10px] text-muted-foreground shrink-0">{formatViews(ex.views)}</span>
          )}
        </div>
      </div>
      {ex.url && (
        <ExternalLinkIcon className="size-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </>
  );

  const baseClass = "flex items-center gap-2 rounded-md px-2 py-1.5 -mx-2";

  if (ex.url) {
    return (
      <a
        href={ex.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${baseClass} hover:bg-accent transition-colors group`}
        onClick={(e) => e.stopPropagation()}
      >
        {inner}
      </a>
    );
  }

  return <div className={baseClass}>{inner}</div>;
}

function FormatPreviewPanel({
  format,
  onClose,
}: {
  format: LibraryFormat;
  onClose: () => void;
}) {
  const isPillar = !format.parentFormatId;

  return (
    <div className="absolute inset-0 z-10 bg-background flex flex-col rounded-lg overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            <h3 className="font-semibold text-sm text-foreground leading-tight">{format.name}</h3>
            <Badge
              variant="outline"
              className={`text-[10px] px-1.5 py-0 font-medium ${
                isPillar
                  ? "bg-blue-50 text-blue-700 border-blue-200"
                  : "bg-purple-50 text-purple-700 border-purple-200"
              }`}
            >
              {isPillar ? "Pillar" : "Derivative"}
            </Badge>
            <Badge
              variant="outline"
              className={`text-[10px] px-1.5 py-0 font-medium ${
                format.isClippableFormat
                  ? "bg-orange-50 text-orange-700 border-orange-200"
                  : "bg-slate-50 text-slate-600 border-slate-200"
              }`}
            >
              {format.isClippableFormat ? "Clip Format" : "Standard Format"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {format.brandLabel}
            {!isPillar && format.parentName && (
              <> · Under <span className="text-foreground/70">{format.parentName}</span></>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md p-1.5 hover:bg-accent transition-colors"
          aria-label="Close preview"
        >
          <XIcon className="size-4 text-muted-foreground" />
        </button>
      </div>

      <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 text-sm">
        {format.postTypes.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Platforms</p>
            <PlatformBadges postTypes={format.postTypes} />
          </div>
        )}

        {(format.isClippableFormat ||
          format.isCanvaFormat ||
          format.labelsAsOriginal ||
          format.clipTargetPostType ||
          format.clipAspectRatio ||
          format.viewThreshold) && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Configuration</p>
            <ul className="space-y-1 text-xs text-foreground/80">
              {format.isClippableFormat && (
                <li>
                  · Clippable format
                  {format.clipTargetPostType && (
                    <span className="text-muted-foreground">
                      {" "}→ {POST_TYPE_LABELS[format.clipTargetPostType] ?? format.clipTargetPostType}
                      {format.clipAspectRatio && ` (${format.clipAspectRatio})`}
                    </span>
                  )}
                </li>
              )}
              {format.isCanvaFormat && <li>· Canva format</li>}
              {format.labelsAsOriginal && <li>· Labels clips as original content</li>}
              {format.viewThreshold != null && (
                <li>· View threshold: {format.viewThreshold.toLocaleString()}</li>
              )}
            </ul>
          </div>
        )}

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1.5">Instructions / Prompt</p>
          {format.instructions ? (
            <pre className="whitespace-pre-wrap font-sans text-xs text-foreground/90 leading-relaxed bg-muted/40 rounded-md p-3 border border-border/60">
              {format.instructions}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground italic">No instructions provided.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function FormatLibraryDialog({ brand, open, onOpenChange, onAdded }: Props) {
  const [libraryFormats, setLibraryFormats] = useState<LibraryFormat[]>([]);
  const [destFormats, setDestFormats] = useState<DestFormat[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBrand, setSelectedBrand] = useState<string | null>(null);
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setCardStates({});

    Promise.all([
      fetch(`/api/format-library?exclude=${encodeURIComponent(brand)}`).then((r) => r.json()),
      fetch(`/api/formats?brand=${encodeURIComponent(brand)}`).then((r) => r.json()),
    ])
      .then(([library, dest]) => {
        const safeLibrary: LibraryFormat[] = Array.isArray(library) ? library : [];
        const safeDest: DestFormat[] = Array.isArray(dest) ? dest : [];
        setLibraryFormats(safeLibrary);
        setDestFormats(safeDest);
        setSelectedBrand(safeLibrary[0]?.brand ?? null);
      })
      .catch(() => toast.error("Failed to load format library"))
      .finally(() => setLoading(false));
  }, [open, brand]);

  const libraryBrands = useMemo(() => {
    const seen = new Map<string, string>();
    for (const f of libraryFormats) {
      if (!seen.has(f.brand)) seen.set(f.brand, f.brandLabel);
    }
    return [...seen.entries()].map(([slug, label]) => ({ slug, label }));
  }, [libraryFormats]);

  const visibleFormats = useMemo(
    () => libraryFormats.filter((f) => f.brand === selectedBrand),
    [libraryFormats, selectedBrand]
  );

  const destPillars = useMemo(
    () => destFormats.filter((f) => !f.parentFormatId),
    [destFormats]
  );

  function patchCard(id: string, patch: Partial<CardState>) {
    setCardStates((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleUse(format: LibraryFormat) {
    const isDerivative = format.parentFormatId !== null;
    let parentFormatId: string | null = null;

    if (isDerivative) {
      if (destPillars.length === 0) return;
      if (destPillars.length === 1) {
        parentFormatId = destPillars[0].id;
      } else {
        parentFormatId = cardStates[format.id]?.selectedParentId ?? null;
        if (!parentFormatId) return;
      }
    }

    patchCard(format.id, { status: "loading", error: undefined });

    try {
      const res = await fetch("/api/format-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceFormatId: format.id,
          destinationBrand: brand,
          parentFormatId,
        }),
      });
      const json = await res.json();
      if (res.status === 409) {
        patchCard(format.id, { status: "error", error: "Already exists in this brand." });
        return;
      }
      if (!res.ok) {
        patchCard(format.id, { status: "error", error: json?.error ?? `HTTP ${res.status}` });
        return;
      }
      patchCard(format.id, { status: "added" });
      toast.success(`"${format.name}" added to your formats`);
      onAdded?.();
    } catch {
      patchCard(format.id, { status: "error", error: "Request failed" });
    }
  }

  function renderAction(format: LibraryFormat) {
    const state = cardStates[format.id] ?? { status: "idle" };
    const isDerivative = format.parentFormatId !== null;

    if (state.status === "added") {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 whitespace-nowrap">
          <CheckIcon className="size-3.5" /> Added
        </span>
      );
    }

    if (isDerivative && destPillars.length === 0) {
      return (
        <span className="text-xs text-muted-foreground italic whitespace-nowrap">
          Add a pillar first
        </span>
      );
    }

    return (
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        {isDerivative && destPillars.length > 1 && (
          <select
            value={state.selectedParentId ?? ""}
            onChange={(e) => patchCard(format.id, { selectedParentId: e.target.value })}
            className="h-7 text-xs rounded-md border border-input bg-background px-2 min-w-[130px]"
          >
            <option value="" disabled>
              Choose parent…
            </option>
            {destPillars.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => patchCard(format.id, { previewing: !state.previewing })}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
          >
            <EyeIcon className="size-3.5" />
            Preview
          </button>
          <Button
            size="sm"
            onClick={() => void handleUse(format)}
            disabled={
              state.status === "loading" ||
              (isDerivative && destPillars.length > 1 && !state.selectedParentId)
            }
          >
            {state.status === "loading" ? "Adding…" : "Use Format"}
          </Button>
        </div>
        {state.status === "error" && state.error && (
          <p className="text-[11px] text-red-600 text-right max-w-[160px]">{state.error}</p>
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-[90vw] sm:max-w-2xl lg:max-w-4xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookOpenIcon className="size-4" />
            Format Library
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
            Loading formats…
          </div>
        ) : libraryBrands.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
            No formats found in other brands.
          </div>
        ) : (
          <div className="flex flex-col min-h-0 flex-1">
            {/* Brand tabs */}
            <div className="flex gap-1 px-6 pt-3 pb-2 border-b shrink-0 overflow-x-auto scrollbar-none">
              {libraryBrands.map(({ slug, label }) => (
                <button
                  key={slug}
                  type="button"
                  onClick={() => setSelectedBrand(slug)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors shrink-0 ${
                    selectedBrand === slug
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Format list */}
            <div className="overflow-y-auto flex-1 px-6 py-3 space-y-2">
              {visibleFormats.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No active formats for this brand.
                </p>
              ) : (
                visibleFormats.map((format) => {
                  const state = cardStates[format.id] ?? { status: "idle" };
                  const isPillar = !format.parentFormatId;
                  const { provenStatus, examples, postTypes } = format;

                  return (
                    <div
                      key={format.id}
                      className={`relative rounded-lg border bg-card transition-opacity overflow-hidden ${
                        state.status === "added" ? "opacity-55" : ""
                      }`}
                    >
                      {/* Preview overlay */}
                      {state.previewing && (
                        <FormatPreviewPanel
                          format={format}
                          onClose={() => patchCard(format.id, { previewing: false })}
                        />
                      )}

                      <div className="p-3.5 flex items-start gap-4">
                        {/* Left: format info */}
                        <div className="min-w-0 flex-1 space-y-2">

                          {/* Name + badges */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-sm text-foreground leading-tight">
                              {format.name}
                            </span>
                            {/* Clip vs Standard — most prominent signal */}
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 font-medium inline-flex items-center gap-0.5 ${
                                format.isClippableFormat
                                  ? "bg-orange-50 text-orange-700 border-orange-200"
                                  : "bg-slate-50 text-slate-600 border-slate-200"
                              }`}
                            >
                              {format.isClippableFormat ? (
                                <><ScissorsIcon className="size-2.5" /> Clip</>
                              ) : (
                                <><FileTextIcon className="size-2.5" /> Standard</>
                              )}
                            </Badge>
                            {/* Pillar / Derivative */}
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 font-medium ${
                                isPillar
                                  ? "bg-blue-50 text-blue-700 border-blue-200"
                                  : "bg-purple-50 text-purple-700 border-purple-200"
                              }`}
                            >
                              {isPillar ? "Pillar" : "Derivative"}
                            </Badge>
                            {/* Performance signals */}
                            {provenStatus?.isProven && (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 font-medium bg-emerald-50 text-emerald-700 border-emerald-200"
                              >
                                Proven
                              </Badge>
                            )}
                            {!provenStatus?.isProven && provenStatus?.reason === "testing" && (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 font-medium bg-sky-50 text-sky-700 border-sky-200"
                              >
                                Active
                              </Badge>
                            )}
                          </div>

                          {/* Source brand + parent */}
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-medium">{format.brandLabel}</span>
                            {!isPillar && format.parentName && (
                              <>
                                <span>·</span>
                                <span>
                                  Under{" "}
                                  <span className="text-foreground/70">{format.parentName}</span>
                                </span>
                              </>
                            )}
                          </div>

                          {/* Platform badges */}
                          {postTypes.length > 0 && <PlatformBadges postTypes={postTypes} />}

                          {/* Examples */}
                          {examples.length > 0 ? (
                            <div className="space-y-0.5 pt-0.5">
                              {examples.map((ex, i) => (
                                <ExampleRow key={i} ex={ex} />
                              ))}
                            </div>
                          ) : (
                            <p className="text-[11px] text-muted-foreground/50 italic pt-0.5">
                              No published examples yet
                            </p>
                          )}
                        </div>

                        {/* Right: actions */}
                        <div className="shrink-0 self-center">{renderAction(format)}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
