"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserChip } from "./user-chip";
import { SS_CHANNELS, MATG_CHANNELS } from "@/lib/config/channels";
import { ChannelChip } from "@/components/ui/channel-chip";
import { AccountBadge } from "@/components/ui/account-badge";
import { SelectPill } from "./filter-pills";
import { buildChannelOptions, channelKey } from "@/lib/channel-options";
import type { FormatChannelWithAccount } from "@/lib/format-channels";
import { cn } from "@/lib/utils";
import { applyStarterTemplate } from "@/lib/format-skill";

interface AsanaMember {
  gid: string;
  name: string;
  email: string;
}

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface FormatRow {
  id: string;
  name: string;
  channels: string[];
  accountChannels: FormatChannelWithAccount[];
  viewThreshold: number | null;
  editor: string | null;
  editorAsanaGid: string | null;
  producer: string | null;
  producerAsanaGid: string | null;
  instructions: string | null;
  parentFormatId: string | null;
  totalViews: number;
}

type SortKey = "name" | "viewThreshold" | "totalViews";

export function FormatsPageContent({ brand }: { brand: string }) {
  const ALL_CHANNELS = brand === "matg" ? MATG_CHANNELS : SS_CHANNELS;

  const [formats, setFormats] = useState<FormatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [channelFilter, setChannelFilter] = useState<string>("all");

  const [asanaMembers, setAsanaMembers] = useState<AsanaMember[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [editorPopoverOpen, setEditorPopoverOpen] = useState(false);
  const [producerPopoverOpen, setProducerPopoverOpen] = useState(false);
  const [parentPopoverOpen, setParentPopoverOpen] = useState(false);

  const [name, setName] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [viewThreshold, setViewThreshold] = useState("");
  const [editor, setEditor] = useState("");
  const [editorAsanaGid, setEditorAsanaGid] = useState("");
  const [producer, setProducer] = useState("");
  const [producerAsanaGid, setProducerAsanaGid] = useState("");
  const [instructions, setInstructions] = useState("");
  const [parentFormatId, setParentFormatId] = useState<string | null>(null);

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
    async function loadMembers() {
      try {
        const res = await fetch("/api/asana-members");
        if (res.ok) {
          const data = await res.json();
          setAsanaMembers(data);
        }
      } catch (err) {
        console.error("Failed to fetch Asana members:", err);
      }
    }
    loadMembers();
  }, []);

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

  function openCreate() {
    setName("");
    setChannels([]);
    setViewThreshold("");
    setEditor("");
    setEditorAsanaGid("");
    setProducer("");
    setProducerAsanaGid("");
    setInstructions("");
    setParentFormatId(null);
    setDialogOpen(true);
  }

  async function handleSave() {
    const body = {
      name,
      brand,
      channels,
      viewThreshold: viewThreshold ? parseInt(viewThreshold, 10) : null,
      editor: editor || null,
      editorAsanaGid: editorAsanaGid || null,
      producer: producer || null,
      producerAsanaGid: producerAsanaGid || null,
      instructions: instructions || null,
      parentFormatId,
    };

    await fetch("/api/formats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setDialogOpen(false);
    fetchFormats();
  }

  function toggleChannel(channel: string) {
    setChannels((prev) =>
      prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel]
    );
  }

  function selectEditor(member: AsanaMember) {
    setEditor(member.name);
    setEditorAsanaGid(member.gid);
    setEditorPopoverOpen(false);
  }

  function clearEditor() {
    setEditor("");
    setEditorAsanaGid("");
    setEditorPopoverOpen(false);
  }

  function selectProducer(member: AsanaMember) {
    setProducer(member.name);
    setProducerAsanaGid(member.gid);
    setProducerPopoverOpen(false);
  }

  function clearProducer() {
    setProducer("");
    setProducerAsanaGid("");
    setProducerPopoverOpen(false);
  }

  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  // Parent-name lookup powers the Pillar column + sort-by-pillar. Depth chain is
  // still needed by the create-dialog's parent picker.
  const { parentNameById, depthById } = useMemo(() => {
    const byId = new Map(formats.map((f) => [f.id, f]));
    const names = new Map<string, string>();
    const depths = new Map<string, number>();
    for (const f of formats) names.set(f.id, f.name);
    for (const f of formats) {
      let depth = 0;
      const seen = new Set<string>();
      let cur = f.parentFormatId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        depth++;
        cur = byId.get(cur)?.parentFormatId ?? null;
      }
      depths.set(f.id, depth);
    }
    return { parentNameById: names, depthById: depths };
  }, [formats]);

  const parentOptions = useMemo(() => {
    return formats
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ ...f, depth: depthById.get(f.id) ?? 0 }));
  }, [formats, depthById]);

  const selectedParent = parentFormatId
    ? formats.find((f) => f.id === parentFormatId) ?? null
    : null;

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

  // Resolve stored editor/producer names to real user rows (for avatars).
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
      }
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
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger>
            <Button onClick={openCreate} className="w-full sm:w-auto">
              Add Format
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>New Format</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Business Breakdown"
                />
              </div>

              <div className="space-y-2">
                <Label>Parent Format</Label>
                <Popover open={parentPopoverOpen} onOpenChange={setParentPopoverOpen}>
                  <PopoverTrigger
                    className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer"
                  >
                    {selectedParent ? (
                      <span className="flex items-center gap-2 truncate">
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-50 text-purple-700">
                          Child of
                        </span>
                        <span className="truncate">{selectedParent.name}</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700">
                          No parent
                        </span>
                        <span className="text-muted-foreground">root / pillar</span>
                      </span>
                    )}
                    <svg
                      className="ml-2 h-4 w-4 shrink-0 opacity-50"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m7 15 5 5 5-5" />
                      <path d="m7 9 5-5 5 5" />
                    </svg>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search formats..." />
                      <CommandList>
                        <CommandEmpty>No matching format.</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            onSelect={() => {
                              setParentFormatId(null);
                              setParentPopoverOpen(false);
                            }}
                          >
                            <span className="flex items-center gap-2">
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700">
                                No parent
                              </span>
                              <span className="text-sm">Root / pillar</span>
                            </span>
                          </CommandItem>
                          {parentOptions.map((opt) => (
                            <CommandItem
                              key={opt.id}
                              value={opt.name}
                              onSelect={() => {
                                setParentFormatId(opt.id);
                                setParentPopoverOpen(false);
                              }}
                              data-checked={parentFormatId === opt.id ? "true" : undefined}
                            >
                              <span className="flex items-center gap-2">
                                <span className="text-xs text-gray-400">
                                  {opt.depth === 0 ? "root" : `depth ${opt.depth}`}
                                </span>
                                <span className="text-sm">{opt.name}</span>
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">
                  Leave empty to make this a root (pillar). Otherwise, this format will be a derivative of the chosen parent.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Channels</Label>
                <div className="flex flex-wrap gap-1.5">
                  {ALL_CHANNELS.map((ch) => {
                    const selected = channels.includes(ch);
                    return (
                      <button
                        key={ch}
                        type="button"
                        onClick={() => toggleChannel(ch)}
                        className={cn(
                          "transition-colors cursor-pointer",
                          selected
                            ? "ring-2 ring-primary ring-offset-1 rounded-md"
                            : "opacity-70 hover:opacity-100"
                        )}
                      >
                        <ChannelChip channel={ch} />
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <Label>View Threshold</Label>
                <Input
                  type="number"
                  value={viewThreshold}
                  onChange={(e) => setViewThreshold(e.target.value)}
                  placeholder="e.g. 50000"
                />
                <p className="text-xs text-muted-foreground">
                  Parent content crossing this number triggers a repurpose task for THIS format.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Editor (Content Creator)</Label>
                <Popover open={editorPopoverOpen} onOpenChange={setEditorPopoverOpen}>
                  <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
                    {editor ? (
                      <span className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-medium">
                          {editor
                            .split(" ")
                            .map((n) => n[0])
                            .join("")
                            .slice(0, 2)}
                        </span>
                        {editor}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Search team members...</span>
                    )}
                    <svg
                      className="ml-2 h-4 w-4 shrink-0 opacity-50"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m7 15 5 5 5-5" />
                      <path d="m7 9 5-5 5 5" />
                    </svg>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search by name or email..." />
                      <CommandList>
                        <CommandEmpty>No team members found.</CommandEmpty>
                        <CommandGroup>
                          {editor && (
                            <CommandItem onSelect={clearEditor} className="text-muted-foreground">
                              <span className="text-sm">Clear selection</span>
                            </CommandItem>
                          )}
                          {asanaMembers.map((member) => (
                            <CommandItem
                              key={member.gid}
                              value={`${member.name} ${member.email}`}
                              onSelect={() => selectEditor(member)}
                              data-checked={editorAsanaGid === member.gid ? "true" : undefined}
                            >
                              <span className="flex items-center gap-2">
                                <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-medium shrink-0">
                                  {member.name
                                    .split(" ")
                                    .map((n) => n[0])
                                    .join("")
                                    .slice(0, 2)}
                                </span>
                                <span className="flex flex-col">
                                  <span className="text-sm font-medium">{member.name}</span>
                                  <span className="text-xs text-muted-foreground">{member.email}</span>
                                </span>
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>Producer (Reviewer + Publisher)</Label>
                <Popover open={producerPopoverOpen} onOpenChange={setProducerPopoverOpen}>
                  <PopoverTrigger className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer">
                    {producer ? (
                      <span className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-xs font-medium">
                          {producer
                            .split(" ")
                            .map((n) => n[0])
                            .join("")
                            .slice(0, 2)}
                        </span>
                        {producer}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Search team members...</span>
                    )}
                    <svg
                      className="ml-2 h-4 w-4 shrink-0 opacity-50"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m7 15 5 5 5-5" />
                      <path d="m7 9 5-5 5 5" />
                    </svg>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search by name or email..." />
                      <CommandList>
                        <CommandEmpty>No team members found.</CommandEmpty>
                        <CommandGroup>
                          {producer && (
                            <CommandItem onSelect={clearProducer} className="text-muted-foreground">
                              <span className="text-sm">Clear selection</span>
                            </CommandItem>
                          )}
                          {asanaMembers.map((member) => (
                            <CommandItem
                              key={member.gid}
                              value={`${member.name} ${member.email}`}
                              onSelect={() => selectProducer(member)}
                              data-checked={producerAsanaGid === member.gid ? "true" : undefined}
                            >
                              <span className="flex items-center gap-2">
                                <span className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-xs font-medium shrink-0">
                                  {member.name
                                    .split(" ")
                                    .map((n) => n[0])
                                    .join("")
                                    .slice(0, 2)}
                                </span>
                                <span className="flex flex-col">
                                  <span className="text-sm font-medium">{member.name}</span>
                                  <span className="text-xs text-muted-foreground">{member.email}</span>
                                </span>
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">
                  Synced from Asana workspace. These roles will be included in Asana task descriptions.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Prompt</Label>
                  <button
                    type="button"
                    onClick={() => setInstructions(applyStarterTemplate(instructions))}
                    className="text-xs text-primary hover:underline"
                  >
                    Load starter template
                  </button>
                </div>
                <Textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Describe this format as a Claude-style skill. Click “Load starter template” for the structure."
                  rows={8}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  One prompt for everything. Read by Claude when Repurpose fires.
                </p>
              </div>

              <Button onClick={handleSave} className="w-full">
                Create
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center gap-2">
        <SelectPill
          label="Channel"
          value={channelFilter}
          options={channelOptions}
          onChange={setChannelFilter}
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
                label="Total Views"
                sortKeyName="totalViews"
                align="right"
              />
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
                  <TableCell className="text-right tabular-nums text-foreground">
                    {f.totalViews > 0 ? f.totalViews.toLocaleString() : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
            {sorted.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
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
