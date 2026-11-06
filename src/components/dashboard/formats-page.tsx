"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useRememberListUrl } from "@/lib/hooks/use-remember-list-url";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserChip } from "./user-chip";
import { AccountBadge } from "@/components/ui/account-badge";
import { SelectPill } from "./filter-pills";
import { buildChannelOptions, channelKey } from "@/lib/channel-options";
import type { FormatChannelWithAccount } from "@/lib/format-channels";
import { AddFormatMenu } from "./add-format-dialog";
import { FormatStatusBadge } from "./format-status-badge";
import { useCanEditBrand } from "@/components/brand-access";
import type { FormatProvenStatus } from "@/lib/services/format-proven-shared";
import type { FormatEditorRules } from "@/lib/db/schema";
import { pendingEditorRules } from "@/lib/format-skill";
import { trackUsage } from "@/lib/usage/track";

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface FormatRow {
  id: string;
  name: string;
  accountChannels: FormatChannelWithAccount[];
  viewThreshold: number | null;
  editor: string | null;
  instructions: string | null;
  parentFormatId: string | null;
  totalViews: number;
  totalPublished: number;
  proven?: boolean;
  provenStatus?: FormatProvenStatus | null;
  editorRules?: FormatEditorRules | null;
}

type SortKey = "name" | "viewThreshold" | "totalViews" | "totalPublished" | "proven";

export function FormatsPageContent({ brand }: { brand: string }) {
  const canEdit = useCanEditBrand(brand);
  const [formats, setFormats] = useState<FormatRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Filter + sort state in the URL — keeps the filtered Formats view
  // shareable and restores it via the detail-page back-link.
  const urlFilters = useUrlState({
    channel: { default: "all" },
    sortKey: { default: "name" },
    sortDir: { default: "asc" },
  });
  const {
    channel: channelFilter,
    sortKey: sortKeyValue,
    sortDir: sortDirValue,
  } = urlFilters.values;
  const sortKey = sortKeyValue as SortKey;
  const sortDir: "asc" | "desc" = sortDirValue === "desc" ? "desc" : "asc";

  useRememberListUrl({ brand, listKey: "formats" });

  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const fetchFormats = useCallback(async () => {
    try {
      const fmtRes = await fetch(`/api/formats?brand=${brand}`);
      const data = await fmtRes.json();
      setFormats(data);
    } catch (err) {
      console.error("Failed to fetch formats:", err);
    } finally {
      setLoading(false);
    }
  }, [brand]);

  useEffect(() => {
    fetchFormats();
  }, [fetchFormats]);


  useEffect(() => {
    async function loadAssignable() {
      try {
        const res = await fetch("/api/users/assignable");
        if (res.ok) {
          const json = await res.json();
          setAssignableUsers(json.users || []);
        }
      } catch (err) {
        console.error("Failed to fetch assignable users:", err);
      }
    }
    loadAssignable();
  }, []);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      urlFilters.set("sortDir", sortDir === "asc" ? "desc" : "asc");
    } else {
      urlFilters.setMany({
        sortKey: key,
        sortDir: key === "name" ? "asc" : "desc",
      });
    }
  }

  // Parent-name lookup powers the Pillar column + sort-by-pillar.
  const parentNameById = useMemo(
    () => new Map(formats.map((f) => [f.id, f.name])),
    [formats]
  );

  const channelOptions = useMemo(
    () => buildChannelOptions(formats.flatMap((f) => f.accountChannels ?? [])),
    [formats]
  );

  const filtered = useMemo(() => {
    if (channelFilter === "all") return formats;
    return formats.filter((f) =>
      (f.accountChannels ?? []).some(
        (c) => channelKey(c.accountId, c.postType) === channelFilter
      )
    );
  }, [formats, channelFilter]);

  // Resolve stored editor names to real user rows (for avatars).
  // Missing matches fall back to plain initials, so unknown names still render.
  const userByName = useMemo(() => {
    const map = new Map<string, AssignableUser>();
    for (const u of assignableUsers) {
      if (u.name) map.set(u.name.toLowerCase(), u);
      map.set(u.email.toLowerCase(), u);
    }
    return map;
  }, [assignableUsers]);

  const resolveUser = (
    value: string | null
  ): { name: string | null; email: string; avatarUrl: string | null } | null => {
    if (!value) return null;
    const hit = userByName.get(value.toLowerCase());
    if (hit) return hit;
    return { name: value, email: value, avatarUrl: null };
  };

  const sorted = useMemo(() => {
    const parentNameOf = (f: FormatRow) =>
      f.parentFormatId ? parentNameById.get(f.parentFormatId) ?? "" : "";

    // For the Name sort, keep derivatives nested under their pillar:
    // primary = pillar group (self-name if pillar, parent-name if derivative),
    // secondary = pillar first (0) then derivatives (1), tertiary = own name.
    if (sortKey === "name") {
      const dir = sortDir === "asc" ? 1 : -1;
      return [...filtered].sort((a, b) => {
        const aGroup = a.parentFormatId ? parentNameOf(a) : a.name;
        const bGroup = b.parentFormatId ? parentNameOf(b) : b.name;
        const g = aGroup.localeCompare(bGroup);
        if (g !== 0) return dir * g;
        const aRank = a.parentFormatId ? 1 : 0;
        const bRank = b.parentFormatId ? 1 : 0;
        if (aRank !== bRank) return aRank - bRank;
        return dir * a.name.localeCompare(b.name);
      });
    }

    const getVal = (f: FormatRow): number | null => {
      switch (sortKey) {
        case "viewThreshold":
          return f.viewThreshold;
        case "totalViews":
          return f.totalViews;
        case "totalPublished":
          return f.totalPublished;
        case "proven":
          // Proven=2, testing=1, stale=0 → sortable ranking
          if (f.proven) return 2;
          if (f.provenStatus?.reason === "testing") return 1;
          return 0;
      }
      return null;
    };
    return [...filtered].sort((a, b) => {
      const aVal = getVal(a);
      const bVal = getVal(b);
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      return sortDir === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [filtered, sortKey, sortDir, parentNameById]);

  function SortHeader({
    label,
    sortKeyName,
    align,
  }: {
    label: string;
    sortKeyName: SortKey;
    align?: "right";
  }) {
    const isActive = sortKey === sortKeyName;
    return (
      <TableHead
        className={`cursor-pointer select-none hover:text-foreground transition-colors ${
          align === "right" ? "text-right" : ""
        }`}
        onClick={() => handleSort(sortKeyName)}
      >
        <span
          className={`inline-flex items-center gap-1 ${
            align === "right" ? "justify-end" : ""
          }`}
        >
          {label}
          {isActive && (
            <span className="text-foreground">
              {sortDir === "asc" ? "\u2191" : "\u2193"}
            </span>
          )}
        </span>
      </TableHead>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        Loading formats...
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Formats</h1>
          <p className="text-xs sm:text-sm text-gray-500">
            Manage content format templates and repurpose chains.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && <AddFormatMenu brand={brand} />}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <SelectPill
          label="Channel"
          value={channelFilter}
          options={channelOptions}
          onChange={(v) => urlFilters.set("channel", v)}
        />
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHeader label="Name" sortKeyName="name" />
              <TableHead>Channels</TableHead>
              <TableHead>Editor</TableHead>
              <SortHeader
                label="Threshold"
                sortKeyName="viewThreshold"
                align="right"
              />
              <SortHeader
                label="Published"
                sortKeyName="totalPublished"
                align="right"
              />
              <SortHeader
                label="Total Views"
                sortKeyName="totalViews"
                align="right"
              />
              <SortHeader label="Status" sortKeyName="proven" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((f) => {
              const isPillar = !f.parentFormatId;
              const parentName = f.parentFormatId
                ? parentNameById.get(f.parentFormatId) ?? null
                : null;
              const editorUser = resolveUser(f.editor);
              return (
                <TableRow key={f.id}>
                  <TableCell>
                    <span className="flex items-center gap-2 min-w-0">
                      {!isPillar && parentName && (
                        <>
                          <Link
                            href={`/${brand}/formats/${f.parentFormatId}`}
                            className="text-muted-foreground hover:text-foreground hover:underline truncate max-w-[180px]"
                          >
                            {parentName}
                          </Link>
                          <span className="text-muted-foreground shrink-0">
                            →
                          </span>
                        </>
                      )}
                      <Link
                        href={`/${brand}/formats/${f.id}`}
                        className="font-medium text-foreground hover:underline truncate"
                      >
                        {f.name}
                      </Link>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                          isPillar
                            ? "bg-blue-50 text-blue-700"
                            : "bg-purple-50 text-purple-700"
                        }`}
                      >
                        {isPillar ? "Pillar" : "Derivative"}
                      </span>
                      {(() => {
                        const pending = pendingEditorRules(f.editorRules, f.instructions).length;
                        if (pending === 0) return null;
                        return (
                          <Link
                            href={`/${brand}/formats/${f.id}#editor-rules`}
                            onClick={() => trackUsage("formats:editor-rules:list", brand)}
                            title="What editors keep changing in this format's AI drafts"
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-amber-50 text-amber-800 hover:bg-amber-100"
                            data-testid="format-editor-rules-chip"
                          >
                            {pending} edit {pending === 1 ? "rule" : "rules"}
                          </Link>
                        );
                      })()}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-[260px]">
                      {(f.accountChannels ?? []).slice(0, 3).map((c) => (
                        <AccountBadge
                          key={`${c.accountId}|${c.postType ?? ""}`}
                          account={c.account}
                          postType={c.postType}
                        />
                      ))}
                      {(f.accountChannels ?? []).length > 3 && (
                        <span className="text-xs text-muted-foreground">
                          +{(f.accountChannels ?? []).length - 3}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {editorUser ? (
                      <UserChip user={editorUser} size="xs" />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {f.viewThreshold != null
                      ? f.viewThreshold.toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {f.totalPublished > 0
                      ? f.totalPublished.toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-foreground">
                    {f.totalViews > 0 ? f.totalViews.toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>
                    <FormatStatusBadge status={f.provenStatus ?? null} />
                  </TableCell>
                </TableRow>
              );
            })}
            {sorted.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-muted-foreground text-xs py-8"
                >
                  {formats.length === 0
                    ? 'No formats yet. Click "Add Format" to create one.'
                    : "No formats match the current filter."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
