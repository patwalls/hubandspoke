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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { SS_CHANNELS, MATG_CHANNELS } from "@/lib/config/channels";

interface AsanaMember {
  gid: string;
  name: string;
  email: string;
}

interface FormatRow {
  id: string;
  name: string;
  channels: string[];
  viewThreshold: number | null;
  editor: string | null;
  editorAsanaGid: string | null;
  producer: string | null;
  producerAsanaGid: string | null;
  instructions: string | null;
  contentType: string | null;
  repurposeTargetIds: string[];
}

/* ------------------------------------------------------------------ */
/*  Sub-components for hierarchical layout                             */
/* ------------------------------------------------------------------ */

function MobileFormatCard({
  f,
  brand,
  onDelete,
  isSpoke,
}: {
  f: FormatRow;
  brand: string;
  onDelete: (id: string) => void;
  isSpoke?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 space-y-2 ${isSpoke ? "bg-gray-50 border-gray-200" : "bg-white border-gray-200"}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            href={`/${brand}/formats/${f.id}`}
            className={`font-medium text-gray-900 hover:underline truncate ${isSpoke ? "text-sm" : ""}`}
          >
            {f.name}
          </Link>
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
            isSpoke ? "bg-purple-50 text-purple-700" : "bg-blue-50 text-blue-700"
          }`}>
            {isSpoke ? "Repurposed" : "Pillar"}
          </span>
        </div>
        <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 shrink-0" onClick={() => onDelete(f.id)}>Delete</Button>
      </div>
      {f.channels?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {f.channels.map((ch) => (
            <Badge key={ch} variant="secondary" className="text-xs">{ch}</Badge>
          ))}
        </div>
      )}
      {f.viewThreshold != null && <p className="text-xs text-gray-500">View Threshold: {f.viewThreshold.toLocaleString()}</p>}
      {(f.editor || f.producer) && (
        <div className="flex flex-wrap gap-3 text-xs text-gray-500">
          {f.editor && (
            <span className="flex items-center gap-1">
              <span className="w-4 h-4 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-[10px] font-medium inline-flex">
                {f.editor.split(" ").map(n => n[0]).join("").slice(0, 2)}
              </span>
              Editor: {f.editor}
            </span>
          )}
          {f.producer && (
            <span className="flex items-center gap-1">
              <span className="w-4 h-4 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-[10px] font-medium inline-flex">
                {f.producer.split(" ").map(n => n[0]).join("").slice(0, 2)}
              </span>
              Producer: {f.producer}
            </span>
          )}
        </div>
      )}
      {f.instructions && (
        <p className="text-xs text-gray-500 line-clamp-2">Instructions: {f.instructions}</p>
      )}
    </div>
  );
}

function FormatTableRow({
  f,
  brand,
  isSpoke,
  onDelete,
}: {
  f: FormatRow;
  brand: string;
  isSpoke?: boolean;
  onDelete: (id: string) => void;
}) {
  return (
    <tr className={`border-b border-gray-100 ${isSpoke ? "bg-gray-50/50" : "hover:bg-gray-50"}`}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {isSpoke && <span className="text-gray-300 text-xs ml-4">└</span>}
          <Link
            href={`/${brand}/formats/${f.id}`}
            className={`hover:underline ${isSpoke ? "text-gray-700 text-sm" : "font-medium text-gray-900"}`}
          >
            {f.name}
          </Link>
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
            isSpoke ? "bg-purple-50 text-purple-700" : "bg-blue-50 text-blue-700"
          }`}>
            {isSpoke ? "Repurposed" : "Pillar"}
          </span>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {f.channels?.map((ch) => (
            <Badge key={ch} variant="secondary" className="text-xs">{ch}</Badge>
          ))}
        </div>
      </td>
      <td className="px-4 py-3 text-gray-600">{f.viewThreshold != null ? f.viewThreshold.toLocaleString() : "-"}</td>
      <td className="px-4 py-3 text-gray-600">
        {f.editor ? (
          <span className="flex items-center gap-1.5">
            <span className="w-5 h-5 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-[10px] font-medium shrink-0">
              {f.editor.split(" ").map(n => n[0]).join("").slice(0, 2)}
            </span>
            <span className="truncate">{f.editor}</span>
          </span>
        ) : "-"}
      </td>
      <td className="px-4 py-3 text-gray-600">
        {f.producer ? (
          <span className="flex items-center gap-1.5">
            <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-[10px] font-medium shrink-0">
              {f.producer.split(" ").map(n => n[0]).join("").slice(0, 2)}
            </span>
            <span className="truncate">{f.producer}</span>
          </span>
        ) : "-"}
      </td>
      <td className="px-4 py-3 text-gray-600 max-w-[200px]">
        {f.instructions ? (
          <span className="line-clamp-2 text-xs">{f.instructions}</span>
        ) : "-"}
      </td>
      <td className="px-4 py-3 text-right">
        <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => onDelete(f.id)}>Delete</Button>
      </td>
    </tr>
  );
}

function HubGroup({
  hub,
  spokes,
  brand,
  expanded,
  onToggle,
  onDelete,
}: {
  hub: FormatRow;
  spokes: FormatRow[];
  brand: string;
  expanded: boolean;
  onToggle: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      {/* Hub row */}
      <tr className="border-b border-gray-100 hover:bg-blue-50/30" style={{ borderLeft: "4px solid #3b82f6" }}>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button onClick={onToggle} className="text-gray-400 hover:text-gray-600 -ml-1 p-0.5">
              <svg
                className={`w-4 h-4 transition-transform ${expanded ? "rotate-90" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <Link
              href={`/${brand}/formats/${hub.id}`}
              className="font-semibold text-gray-900 hover:underline"
            >
              {hub.name}
            </Link>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700">
              Pillar
            </span>
            {spokes.length > 0 && (
              <span className="text-[10px] text-gray-400 font-medium bg-gray-100 px-1.5 py-0.5 rounded-full">
                {spokes.length} repurposed
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {hub.channels?.map((ch) => (
              <Badge key={ch} variant="secondary" className="text-xs">{ch}</Badge>
            ))}
          </div>
        </td>
        <td className="px-4 py-3 text-gray-600">{hub.viewThreshold != null ? hub.viewThreshold.toLocaleString() : "-"}</td>
        <td className="px-4 py-3 text-gray-600">
          {hub.editor ? (
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-[10px] font-medium shrink-0">
                {hub.editor.split(" ").map(n => n[0]).join("").slice(0, 2)}
              </span>
              <span className="truncate">{hub.editor}</span>
            </span>
          ) : "-"}
        </td>
        <td className="px-4 py-3 text-gray-600">
          {hub.producer ? (
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-[10px] font-medium shrink-0">
                {hub.producer.split(" ").map(n => n[0]).join("").slice(0, 2)}
              </span>
              <span className="truncate">{hub.producer}</span>
            </span>
          ) : "-"}
        </td>
        <td className="px-4 py-3 text-gray-600 max-w-[200px]">
          {hub.instructions ? (
            <span className="line-clamp-2 text-xs">{hub.instructions}</span>
          ) : "-"}
        </td>
        <td className="px-4 py-3 text-right">
          <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => onDelete(hub.id)}>Delete</Button>
        </td>
      </tr>
      {/* Spoke rows */}
      {expanded && spokes.map((s) => (
        <FormatTableRow key={s.id} f={s} brand={brand} isSpoke onDelete={onDelete} />
      ))}
    </>
  );
}

export function FormatsPageContent({ brand }: { brand: string }) {
  const ALL_CHANNELS = brand === "matg" ? MATG_CHANNELS : SS_CHANNELS;

  const [formats, setFormats] = useState<FormatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  // Asana members
  const [asanaMembers, setAsanaMembers] = useState<AsanaMember[]>([]);
  const [editorPopoverOpen, setEditorPopoverOpen] = useState(false);
  const [producerPopoverOpen, setProducerPopoverOpen] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [viewThreshold, setViewThreshold] = useState("");
  const [editor, setEditor] = useState("");
  const [editorAsanaGid, setEditorAsanaGid] = useState("");
  const [producer, setProducer] = useState("");
  const [producerAsanaGid, setProducerAsanaGid] = useState("");
  const [instructions, setInstructions] = useState("");
  const [contentType, setContentType] = useState<string>("pillar");
  const [repurposeTargetIds, setRepurposeTargetIds] = useState<string[]>([]);

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

  // Fetch Asana workspace members once
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

  function openCreate() {
    setName("");
    setChannels([]);
    setViewThreshold("");
    setEditor("");
    setEditorAsanaGid("");
    setProducer("");
    setProducerAsanaGid("");
    setInstructions("");
    setContentType("pillar");
    setRepurposeTargetIds([]);
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
      contentType,
      repurposeTargetIds,
    };

    await fetch("/api/formats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setDialogOpen(false);
    fetchFormats();
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this format?")) return;
    await fetch("/api/formats", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    fetchFormats();
  }

  function toggleChannel(channel: string) {
    setChannels((prev) =>
      prev.includes(channel)
        ? prev.filter((c) => c !== channel)
        : [...prev, channel]
    );
  }

  function toggleRepurpose(formatId: string) {
    setRepurposeTargetIds((prev) =>
      prev.includes(formatId)
        ? prev.filter((id) => id !== formatId)
        : [...prev, formatId]
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

  const [expandedHubs, setExpandedHubs] = useState<Set<string>>(new Set());

  // Initialize all hubs as expanded when formats load
  useEffect(() => {
    const hubIds = formats
      .filter((f) => (f.contentType || "pillar") === "pillar")
      .map((f) => f.id);
    setExpandedHubs(new Set(hubIds));
  }, [formats]);

  function toggleHub(hubId: string) {
    setExpandedHubs((prev) => {
      const next = new Set(prev);
      if (next.has(hubId)) next.delete(hubId);
      else next.add(hubId);
      return next;
    });
  }

  // Build grouped hierarchy: hubs with their spokes, then orphan spokes
  const { hubGroups, orphanSpokes } = useMemo(() => {
    // Build reverse lookup: spokeId → hubId
    const spokeToHub = new Map<string, string>();
    formats.forEach((f) => {
      if ((f.contentType || "pillar") === "pillar" && f.repurposeTargetIds?.length) {
        f.repurposeTargetIds.forEach((tid) => spokeToHub.set(tid, f.id));
      }
    });

    // Apply filters
    const filtered = formats.filter((f) => {
      if (channelFilter !== "all" && !f.channels?.includes(channelFilter)) return false;
      if (typeFilter !== "all" && (f.contentType || "pillar") !== typeFilter) return false;
      return true;
    });

    const filteredIds = new Set(filtered.map((f) => f.id));

    // Hubs with their visible spokes
    const hubs = filtered.filter((f) => (f.contentType || "pillar") === "pillar");
    const groups = hubs.map((hub) => {
      const spokeIds = hub.repurposeTargetIds || [];
      const spokes = spokeIds
        .map((sid) => formats.find((f) => f.id === sid))
        .filter((s): s is FormatRow => {
          if (!s) return false;
          // Apply channel filter to spokes too
          if (channelFilter !== "all" && !s.channels?.includes(channelFilter)) return false;
          return true;
        });
      return { hub, spokes };
    });

    // Orphan spokes: repurposed formats not claimed by any hub, that pass filters
    const orphans = filtered.filter(
      (f) => f.contentType === "repurposed" && !spokeToHub.has(f.id)
    );

    return { hubGroups: groups, orphanSpokes: orphans };
  }, [formats, channelFilter, typeFilter]);

  // For type filter "repurposed" — show all spokes flat
  const allFilteredSpokes = useMemo(() => {
    if (typeFilter !== "repurposed") return [];
    return formats.filter((f) => {
      if ((f.contentType || "pillar") !== "repurposed") return false;
      if (channelFilter !== "all" && !f.channels?.includes(channelFilter)) return false;
      return true;
    });
  }, [formats, channelFilter, typeFilter]);

  const totalVisible = typeFilter === "repurposed"
    ? allFilteredSpokes.length
    : hubGroups.length + orphanSpokes.length;

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
            <Button onClick={openCreate} className="w-full sm:w-auto">Add Format</Button>
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
                <Label>Content Type</Label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setContentType("pillar")}
                    className={`flex-1 flex items-center gap-2 rounded-lg border-2 px-3 py-2.5 text-sm transition-all ${
                      contentType === "pillar"
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <span className="text-base">🎯</span>
                    <span>
                      <span className="font-medium block">Pillar</span>
                      <span className="text-xs opacity-75">Hub content</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setContentType("repurposed")}
                    className={`flex-1 flex items-center gap-2 rounded-lg border-2 px-3 py-2.5 text-sm transition-all ${
                      contentType === "repurposed"
                        ? "border-purple-500 bg-purple-50 text-purple-700"
                        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <span className="text-base">🔄</span>
                    <span>
                      <span className="font-medium block">Repurposed</span>
                      <span className="text-xs opacity-75">Spoke content</span>
                    </span>
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Channels</Label>
                <div className="flex flex-wrap gap-2">
                  {ALL_CHANNELS.map((ch) => (
                    <Badge
                      key={ch}
                      variant={channels.includes(ch) ? "default" : "outline"}
                      className="cursor-pointer"
                      onClick={() => toggleChannel(ch)}
                    >
                      {ch}
                    </Badge>
                  ))}
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
              </div>

              {/* Editor - Asana member combobox */}
              <div className="space-y-2">
                <Label>Editor (Content Creator)</Label>
                <Popover open={editorPopoverOpen} onOpenChange={setEditorPopoverOpen}>
                  <PopoverTrigger
                    className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer"
                  >
                    {editor ? (
                      <span className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-medium">
                          {editor.split(" ").map(n => n[0]).join("").slice(0, 2)}
                        </span>
                        {editor}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Search team members...</span>
                    )}
                    <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
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
                                  {member.name.split(" ").map(n => n[0]).join("").slice(0, 2)}
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

              {/* Producer - Asana member combobox */}
              <div className="space-y-2">
                <Label>Producer (Reviewer + Publisher)</Label>
                <Popover open={producerPopoverOpen} onOpenChange={setProducerPopoverOpen}>
                  <PopoverTrigger
                    className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer"
                  >
                    {producer ? (
                      <span className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-xs font-medium">
                          {producer.split(" ").map(n => n[0]).join("").slice(0, 2)}
                        </span>
                        {producer}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Search team members...</span>
                    )}
                    <svg className="ml-2 h-4 w-4 shrink-0 opacity-50" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>
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
                                  {member.name.split(" ").map(n => n[0]).join("").slice(0, 2)}
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

              {/* Instructions / Format Notes */}
              <div className="space-y-2">
                <Label>Format Instructions</Label>
                <Textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Add instructions, loom links, style guides, etc. This will be included in Asana tasks."
                  rows={4}
                />
                <p className="text-xs text-muted-foreground">
                  These instructions will be added to the Asana task notes when repurpose tasks are triggered.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Repurpose Targets</Label>
                <div className="flex flex-wrap gap-2">
                  {formats.map((f) => (
                      <Badge
                        key={f.id}
                        variant={
                          repurposeTargetIds.includes(f.id)
                            ? "default"
                            : "outline"
                        }
                        className="cursor-pointer"
                        onClick={() => toggleRepurpose(f.id)}
                      >
                        {f.name}
                      </Badge>
                    ))}
                </div>
              </div>
              <Button onClick={handleSave} className="w-full">Create</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
        <div className="flex items-center gap-2">
          <Label className="text-sm text-gray-600 whitespace-nowrap">Type:</Label>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              onClick={() => setTypeFilter("all")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                typeFilter === "all" ? "bg-gray-900 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >All</button>
            <button
              onClick={() => setTypeFilter("pillar")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-200 ${
                typeFilter === "pillar" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >🎯 Pillar</button>
            <button
              onClick={() => setTypeFilter("repurposed")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-200 ${
                typeFilter === "repurposed" ? "bg-purple-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >🔄 Repurposed</button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-sm text-gray-600 whitespace-nowrap">Channel:</Label>
          <Select value={channelFilter} onValueChange={(v) => setChannelFilter(v ?? "all")}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {ALL_CHANNELS.map((ch) => (
                <SelectItem key={ch} value={ch}>
                  {ch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Mobile card view */}
      <div className="sm:hidden space-y-3">
        {typeFilter === "repurposed" ? (
          // Flat spoke list when filtering to repurposed only
          allFilteredSpokes.map((f) => (
            <MobileFormatCard key={f.id} f={f} brand={brand} onDelete={handleDelete} isSpoke />
          ))
        ) : (
          <>
            {hubGroups.map(({ hub, spokes }) => (
              <div key={hub.id} className="space-y-0">
                {/* Hub card */}
                <div className="bg-white rounded-lg border-2 border-blue-200 p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleHub(hub.id)}
                        className="text-gray-400 hover:text-gray-600 -ml-1"
                      >
                        <svg
                          className={`w-4 h-4 transition-transform ${expandedHubs.has(hub.id) ? "rotate-90" : ""}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <Link
                        href={`/${brand}/formats/${hub.id}`}
                        className="font-semibold text-gray-900 hover:underline"
                      >
                        {hub.name}
                      </Link>
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700">
                        Pillar
                      </span>
                      {spokes.length > 0 && (
                        <span className="text-[10px] text-gray-400 font-medium">
                          {spokes.length} repurposed
                        </span>
                      )}
                    </div>
                    <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => handleDelete(hub.id)}>Delete</Button>
                  </div>
                  {hub.channels?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {hub.channels.map((ch) => (
                        <Badge key={ch} variant="secondary" className="text-xs">{ch}</Badge>
                      ))}
                    </div>
                  )}
                  {hub.viewThreshold != null && <p className="text-xs text-gray-500">View Threshold: {hub.viewThreshold.toLocaleString()}</p>}
                  {(hub.editor || hub.producer) && (
                    <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                      {hub.editor && (
                        <span className="flex items-center gap-1">
                          <span className="w-4 h-4 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-[10px] font-medium inline-flex">
                            {hub.editor.split(" ").map(n => n[0]).join("").slice(0, 2)}
                          </span>
                          Editor: {hub.editor}
                        </span>
                      )}
                      {hub.producer && (
                        <span className="flex items-center gap-1">
                          <span className="w-4 h-4 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-[10px] font-medium inline-flex">
                            {hub.producer.split(" ").map(n => n[0]).join("").slice(0, 2)}
                          </span>
                          Producer: {hub.producer}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {/* Spoke cards nested under hub */}
                {expandedHubs.has(hub.id) && spokes.length > 0 && (
                  <div className="ml-4 border-l-2 border-blue-100 space-y-2 pt-2 pl-3">
                    {spokes.map((s) => (
                      <MobileFormatCard key={s.id} f={s} brand={brand} onDelete={handleDelete} isSpoke />
                    ))}
                  </div>
                )}
              </div>
            ))}
            {/* Orphan spokes */}
            {orphanSpokes.map((f) => (
              <MobileFormatCard key={f.id} f={f} brand={brand} onDelete={handleDelete} isSpoke />
            ))}
          </>
        )}
        {totalVisible === 0 && (
          <div className="py-8 text-center text-gray-400 text-sm">
            {formats.length === 0 ? 'No formats yet. Click "Add Format" to create one.' : "No formats match the current filters."}
          </div>
        )}
      </div>

      {/* Desktop table view */}
      <div className="hidden sm:block bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Channels</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">View Threshold</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Editor</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Producer</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Instructions</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {typeFilter === "repurposed" ? (
              // Flat spoke list when filtering to repurposed only
              allFilteredSpokes.map((f) => (
                <FormatTableRow key={f.id} f={f} brand={brand} isSpoke onDelete={handleDelete} />
              ))
            ) : (
              <>
                {hubGroups.map(({ hub, spokes }) => (
                  <HubGroup
                    key={hub.id}
                    hub={hub}
                    spokes={spokes}
                    brand={brand}
                    expanded={expandedHubs.has(hub.id)}
                    onToggle={() => toggleHub(hub.id)}
                    onDelete={handleDelete}
                  />
                ))}
                {/* Orphan spokes */}
                {orphanSpokes.map((f) => (
                  <FormatTableRow key={f.id} f={f} brand={brand} isSpoke onDelete={handleDelete} />
                ))}
              </>
            )}
            {totalVisible === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                  {formats.length === 0
                    ? 'No formats yet. Click "Add Format" to create one.'
                    : "No formats match the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
