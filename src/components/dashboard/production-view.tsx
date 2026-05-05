"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isNotionAuthoritative } from "@/lib/platform";
import { statusClassFromToken } from "@/lib/badge-colors";
import {
  ProductionPipelineTable,
  type SortDir,
  type SortKey,
} from "./production-pipeline-table";
import { SelectPill } from "./filter-pills";
import { personDisplay } from "./user-chip";
import { buildChannelOptions, matchesChannel } from "@/lib/channel-options";
import type { ProductionItem } from "@/types";

interface ProductionViewProps {
  brand: string;
  /** UUID of the currently logged-in user. Drives the "Just me" editor
   *  filter pin. Null if the page somehow renders without a session. */
  currentUserId: string | null;
}

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/** Tiny avatar for the editor filter dropdown — matches the size of the
 *  PlatformIcon used in the other filter pills (12-18px range). */
function EditorAvatar({ user }: { user: AssignableUser }) {
  const { initials, colorClass } = personDisplay(user);
  if (user.avatarUrl) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={user.avatarUrl}
        alt=""
        className="w-4 h-4 rounded-full object-cover shrink-0 bg-accent"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span
      className={`w-4 h-4 rounded-full flex items-center justify-center font-semibold shrink-0 text-[8px] ${colorClass}`}
    >
      {initials}
    </span>
  );
}

type PipelineStatus = {
  id: string;
  name: string;
  color: string;
  position: number;
};

// Fallback list, used only if the API call fails. Late-stage first so the
// view leads with what's almost done. Long-form YouTube pillars are
// excluded — those live in Notion (filtered via isNotionAuthoritative
// below). Idea-stage triage moved to /[brand]/queue.
const FALLBACK_PIPELINE_STATUSES: PipelineStatus[] = [
  { id: "fb-rtp", name: "Ready To Publish", color: "pink", position: 4 },
  { id: "fb-fr", name: "Final Review", color: "orange", position: 3 },
  { id: "fb-r", name: "Review", color: "yellow", position: 2 },
  { id: "fb-a", name: "Assigned", color: "pink", position: 1 },
];

const SOURCES = [
  { value: "all", label: "All sources" },
  { value: "original", label: "Original" },
  { value: "repost", label: "Repost" },
  { value: "cross_post", label: "Cross-post" },
];

// Encoded as `<key>:<dir>` so the SelectPill (string-typed) can drive the
// lifted sort state for every status table at once. "default" = preserve
// API order; the other options surface the most useful sorts up front.
// Clicking a column header inside any table updates the same lifted
// state, so the pill stays in sync.
const SORT_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "created:desc", label: "Created (newest)" },
  { value: "created:asc", label: "Created (oldest)" },
  { value: "views:desc", label: "Est. views (high → low)" },
  { value: "views:asc", label: "Est. views (low → high)" },
  { value: "editor:asc", label: "Editor (A → Z)" },
];

function decodeSort(value: string): {
  key: SortKey | null;
  dir: SortDir;
} {
  if (value === "default") return { key: null, dir: "asc" };
  const [keyPart, dirPart] = value.split(":");
  const key = keyPart as SortKey;
  const dir: SortDir = dirPart === "asc" ? "asc" : "desc";
  return { key, dir };
}

function encodeSort(key: SortKey | null, dir: SortDir): string {
  if (!key) return "default";
  return `${key}:${dir}`;
}

export function ProductionView({ brand, currentUserId }: ProductionViewProps) {
  const [items, setItems] = useState<ProductionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pipelineStatuses, setPipelineStatuses] = useState<PipelineStatus[]>(
    FALLBACK_PIPELINE_STATUSES
  );
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [search, setSearch] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState("all");
  const [selectedFormat, setSelectedFormat] = useState("all");
  const [selectedSource, setSelectedSource] = useState("all");
  const [selectedEditor, setSelectedEditor] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        // Same key clicked again → flip direction.
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      // New key → desc by default for numeric/date columns, asc for text.
      setSortDir(key === "views" || key === "created" ? "desc" : "asc");
      return key;
    });
  }, []);

  const fetchPipeline = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/reports/production?brand=${encodeURIComponent(brand)}`
      );
      if (!res.ok) {
        console.error(`Production API returned HTTP ${res.status}`);
        setItems([]);
        return;
      }
      const json = await res.json();
      setItems(json.items ?? []);
    } catch (err) {
      console.error("Failed to fetch production pipeline:", err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [brand]);

  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/users/assignable");
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setUsers(json.users ?? []);
      } catch {
        // Editor filter falls back to the implicit list derived from
        // pipeline rows themselves (see editorOptions below).
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/brand-statuses?brand=${encodeURIComponent(
            brand
          )}&pipelineOnly=1`
        );
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        // Sort by position descending so late-stage statuses (Ready To
        // Publish, Final Review) surface at the top — this view answers
        // "what's almost done?", not "what's earliest in the pipeline?".
        const list: PipelineStatus[] = (json.statuses ?? [])
          .map((s: PipelineStatus) => ({
            id: s.id,
            name: s.name,
            color: s.color,
            position: s.position,
          }))
          .sort(
            (a: PipelineStatus, b: PipelineStatus) => b.position - a.position
          );
        if (list.length > 0) setPipelineStatuses(list);
      } catch {
        // Keep the fallback statuses on any failure.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [brand]);

  const pipelineNameSet = useMemo(
    () => new Set(pipelineStatuses.map((s) => s.name)),
    [pipelineStatuses]
  );
  const hsItems = items.filter((item) => !isNotionAuthoritative(item.postType));
  const pipelineCandidates = hsItems.filter(
    (item) => item.status && pipelineNameSet.has(item.status)
  );

  const platformOptions = useMemo(
    () => buildChannelOptions(pipelineCandidates),
    [pipelineCandidates]
  );

  const formatOptions = useMemo(() => {
    const set = new Set<string>();
    for (const item of pipelineCandidates) {
      if (item.format) set.add(item.format);
    }
    return [
      { value: "all", label: "All formats" },
      ...Array.from(set)
        .sort((a, b) => a.localeCompare(b))
        .map((f) => ({ value: f, label: f })),
    ];
  }, [pipelineCandidates]);

  // Editor pill: "All editors", then "Just me" (current user, pinned),
  // then everyone else who actually has at least one row in the pipeline,
  // sorted by name. Filtering the dropdown to active editors keeps it from
  // ballooning past the team — when the user wants someone who doesn't
  // currently appear in the queue, they can search by name.
  const editorOptions = useMemo(() => {
    const usersById = new Map(users.map((u) => [u.id, u]));
    const activeEditorIds = new Set<string>();
    for (const item of pipelineCandidates) {
      if (item.editorUserId) activeEditorIds.add(item.editorUserId);
    }

    const opts: { value: string; label: string; icon?: React.ReactNode }[] = [
      { value: "all", label: "All editors" },
    ];

    const me = currentUserId ? usersById.get(currentUserId) ?? null : null;
    if (me) {
      opts.push({
        value: me.id,
        label: "Just me",
        icon: <EditorAvatar user={me} />,
      });
    }

    const rest = users
      .filter((u) => u.id !== currentUserId && activeEditorIds.has(u.id))
      .sort((a, b) => {
        const an = (a.name ?? a.email).toLowerCase();
        const bn = (b.name ?? b.email).toLowerCase();
        return an.localeCompare(bn);
      });
    for (const u of rest) {
      opts.push({
        value: u.id,
        label: u.name ?? u.email,
        icon: <EditorAvatar user={u} />,
      });
    }

    return opts;
  }, [users, currentUserId, pipelineCandidates]);

  const query = search.trim().toLowerCase();
  const matchesQuery = (item: ProductionItem): boolean => {
    if (!query) return true;
    const title = item.title?.toLowerCase() ?? "";
    const format = item.format?.toLowerCase() ?? "";
    const platforms = item.platform?.join(" ").toLowerCase() ?? "";
    const producer = item.producerEmail?.toLowerCase() ?? "";
    return (
      title.includes(query) ||
      format.includes(query) ||
      platforms.includes(query) ||
      producer.includes(query)
    );
  };

  const pipelineItems = pipelineCandidates.filter((item) => {
    if (!matchesChannel(item, selectedPlatform)) return false;
    if (selectedFormat !== "all") {
      if (item.format !== selectedFormat) return false;
    }
    if (selectedSource !== "all") {
      const source = item.sourceType ?? "original";
      if (source !== selectedSource) return false;
    }
    if (selectedEditor !== "all") {
      if (item.editorUserId !== selectedEditor) return false;
    }
    return matchesQuery(item);
  });

  const byStatus = new Map<string, ProductionItem[]>();
  for (const s of pipelineStatuses) byStatus.set(s.name, []);
  for (const item of pipelineItems) {
    const bucket = item.status ? byStatus.get(item.status) : null;
    if (bucket) bucket.push(item);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
            Production
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Track content moving through the pipeline.
          </p>
        </div>
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, format, channel, producer…"
          className="h-8 w-48 sm:w-72 text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SelectPill
          label="Editor"
          value={selectedEditor}
          options={editorOptions}
          onChange={setSelectedEditor}
        />
        <SelectPill
          label="Channel"
          value={selectedPlatform}
          options={platformOptions}
          onChange={setSelectedPlatform}
        />
        <SelectPill
          label="Format"
          value={selectedFormat}
          options={formatOptions}
          onChange={setSelectedFormat}
        />
        <SelectPill
          label="Source"
          value={selectedSource}
          options={SOURCES}
          onChange={setSelectedSource}
        />
        <SelectPill
          label="Sort"
          value={encodeSort(sortKey, sortDir)}
          options={SORT_OPTIONS}
          onChange={(value) => {
            const { key, dir } = decodeSort(value);
            setSortKey(key);
            setSortDir(dir);
          }}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex items-center gap-2 text-muted-foreground">
            <svg
              className="animate-spin h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm">Loading production pipeline…</span>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {pipelineStatuses.map((status) => {
            const statusItems = byStatus.get(status.name) ?? [];
            if (statusItems.length === 0) return null;
            return (
              <section key={status.id} className="space-y-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border",
                      statusClassFromToken(status.color)
                    )}
                  >
                    {status.name}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {statusItems.length}
                  </span>
                </div>
                <ProductionPipelineTable
                  items={statusItems}
                  brand={brand}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
              </section>
            );
          })}

          {pipelineItems.length === 0 && (
            <div className="text-center py-20">
              <p className="text-muted-foreground text-sm">
                {query ||
                selectedPlatform !== "all" ||
                selectedFormat !== "all" ||
                selectedSource !== "all" ||
                selectedEditor !== "all"
                  ? "No items match the current filters."
                  : "No items in the pipeline."}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
