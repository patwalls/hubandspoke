"use client";

import { useState, useEffect, useCallback } from "react";
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

interface AsanaMember {
  gid: string;
  name: string;
  email: string;
}

interface FormatRow {
  id: string;
  name: string;
  channels: string[];
  event: string | null;
  viewThreshold: number | null;
  contentOwner: string | null;
  contentOwnerAsanaGid: string | null;
  instructions: string | null;
  contentType: string | null;
  repurposeTargetIds: string[];
}

const SS_CHANNELS = [
  "YouTube (SS)",
  "YouTube (SS Build)",
  "YouTube Shorts",
  "YouTube Community",
  "Instagram Post",
  "Instagram Reel",
  "Instagram Story",
  "Twitter",
  "LinkedIn",
  "TikTok",
  "Threads",
  "Newsletter",
  "SS Case Study",
  "SS Database",
  "Paid Ad",
];

const MATG_CHANNELS = [
  "YouTube",
  "YouTube Shorts",
  "Instagram Post",
  "Instagram Reel",
  "Instagram Story",
  "Twitter",
  "LinkedIn",
  "TikTok",
  "Threads",
];

export function FormatsPageContent({ brand }: { brand: string }) {
  const ALL_CHANNELS = brand === "matg" ? MATG_CHANNELS : SS_CHANNELS;

  const [formats, setFormats] = useState<FormatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingFormat, setEditingFormat] = useState<FormatRow | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  // Asana members
  const [asanaMembers, setAsanaMembers] = useState<AsanaMember[]>([]);
  const [ownerPopoverOpen, setOwnerPopoverOpen] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [event, setEvent] = useState("");
  const [viewThreshold, setViewThreshold] = useState("");
  const [contentOwner, setContentOwner] = useState("");
  const [contentOwnerAsanaGid, setContentOwnerAsanaGid] = useState("");
  const [instructions, setInstructions] = useState("");
  const [contentType, setContentType] = useState<string>("pillar");
  const [repurposeTargetIds, setRepurposeTargetIds] = useState<string[]>([]);

  const fetchFormats = useCallback(async () => {
    try {
      const res = await fetch(`/api/formats?brand=${brand}`);
      const data = await res.json();
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
    setEditingFormat(null);
    setName("");
    setChannels([]);
    setEvent("");
    setViewThreshold("");
    setContentOwner("");
    setContentOwnerAsanaGid("");
    setInstructions("");
    setContentType("pillar");
    setRepurposeTargetIds([]);
    setDialogOpen(true);
  }

  function openEdit(f: FormatRow) {
    setEditingFormat(f);
    setName(f.name);
    setChannels(f.channels || []);
    setEvent(f.event || "");
    setViewThreshold(f.viewThreshold != null ? String(f.viewThreshold) : "");
    setContentOwner(f.contentOwner || "");
    setContentOwnerAsanaGid(f.contentOwnerAsanaGid || "");
    setInstructions(f.instructions || "");
    setContentType(f.contentType || "pillar");
    setRepurposeTargetIds(f.repurposeTargetIds || []);
    setDialogOpen(true);
  }

  async function handleSave() {
    const body = {
      id: editingFormat?.id,
      name,
      brand,
      channels,
      event: event || null,
      viewThreshold: viewThreshold ? parseInt(viewThreshold, 10) : null,
      contentOwner: contentOwner || null,
      contentOwnerAsanaGid: contentOwnerAsanaGid || null,
      instructions: instructions || null,
      contentType,
      repurposeTargetIds,
    };

    const method = editingFormat ? "PUT" : "POST";
    await fetch("/api/formats", {
      method,
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

  function selectOwner(member: AsanaMember) {
    setContentOwner(member.name);
    setContentOwnerAsanaGid(member.gid);
    setOwnerPopoverOpen(false);
  }

  function clearOwner() {
    setContentOwner("");
    setContentOwnerAsanaGid("");
    setOwnerPopoverOpen(false);
  }

  const filteredFormats = formats.filter((f) => {
    if (channelFilter !== "all" && !f.channels?.includes(channelFilter)) return false;
    if (typeFilter !== "all" && (f.contentType || "pillar") !== typeFilter) return false;
    return true;
  });

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
              <DialogTitle>
                {editingFormat ? "Edit Format" : "New Format"}
              </DialogTitle>
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
                <Label>Event</Label>
                <Input
                  value={event}
                  onChange={(e) => setEvent(e.target.value)}
                  placeholder="e.g. Database Published"
                />
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

              {/* Content Owner - Asana member combobox */}
              <div className="space-y-2">
                <Label>Content Owner</Label>
                <Popover open={ownerPopoverOpen} onOpenChange={setOwnerPopoverOpen}>
                  <PopoverTrigger
                    className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer"
                  >
                    {contentOwner ? (
                      <span className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-medium">
                          {contentOwner.split(" ").map(n => n[0]).join("").slice(0, 2)}
                        </span>
                        {contentOwner}
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
                          {contentOwner && (
                            <CommandItem onSelect={clearOwner} className="text-muted-foreground">
                              <span className="text-sm">Clear selection</span>
                            </CommandItem>
                          )}
                          {asanaMembers.map((member) => (
                            <CommandItem
                              key={member.gid}
                              value={`${member.name} ${member.email}`}
                              onSelect={() => selectOwner(member)}
                              data-checked={contentOwnerAsanaGid === member.gid ? "true" : undefined}
                            >
                              <span className="flex items-center gap-2">
                                <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-medium shrink-0">
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
                  Synced from Asana workspace. This person will be auto-assigned when repurpose tasks are created.
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
                  {formats
                    .filter((f) => f.id !== editingFormat?.id)
                    .map((f) => (
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
              <Button onClick={handleSave} className="w-full">
                {editingFormat ? "Update" : "Create"}
              </Button>
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
        {filteredFormats.map((f) => (
          <div key={f.id} className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900">{f.name}</span>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  (f.contentType || "pillar") === "pillar"
                    ? "bg-blue-50 text-blue-700"
                    : "bg-purple-50 text-purple-700"
                }`}>
                  {(f.contentType || "pillar") === "pillar" ? "🎯 Hub" : "🔄 Spoke"}
                </span>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => openEdit(f)}>Edit</Button>
                <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => handleDelete(f.id)}>Delete</Button>
              </div>
            </div>
            {f.channels?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {f.channels.map((ch) => (
                  <Badge key={ch} variant="secondary" className="text-xs">{ch}</Badge>
                ))}
              </div>
            )}
            {f.event && <p className="text-xs text-gray-500">Event: {f.event}</p>}
            {f.viewThreshold != null && <p className="text-xs text-gray-500">View Threshold: {f.viewThreshold.toLocaleString()}</p>}
            {f.contentOwner && (
              <p className="text-xs text-gray-500 flex items-center gap-1">
                <span className="w-4 h-4 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-medium inline-flex">
                  {f.contentOwner.split(" ").map(n => n[0]).join("").slice(0, 2)}
                </span>
                {f.contentOwner}
              </p>
            )}
            {f.instructions && (
              <p className="text-xs text-gray-500 line-clamp-2">Instructions: {f.instructions}</p>
            )}
            {f.repurposeTargetIds?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {f.repurposeTargetIds.map((targetId) => {
                  const target = formats.find((ff) => ff.id === targetId);
                  return target ? <Badge key={targetId} variant="outline" className="text-xs">{target.name}</Badge> : null;
                })}
              </div>
            )}
          </div>
        ))}
        {filteredFormats.length === 0 && (
          <div className="py-8 text-center text-gray-400 text-sm">
            {formats.length === 0 ? 'No formats yet. Click "Add Format" to create one.' : `No formats for ${channelFilter}.`}
          </div>
        )}
      </div>

      {/* Desktop table view */}
      <div className="hidden sm:block bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Channels</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Event</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">View Threshold</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Owner</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Instructions</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Repurpose Targets</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredFormats.map((f) => (
              <tr key={f.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{f.name}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                    (f.contentType || "pillar") === "pillar"
                      ? "bg-blue-50 text-blue-700"
                      : "bg-purple-50 text-purple-700"
                  }`}>
                    {(f.contentType || "pillar") === "pillar" ? "🎯 Hub" : "🔄 Spoke"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {f.channels?.map((ch) => (
                      <Badge key={ch} variant="secondary" className="text-xs">{ch}</Badge>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-600">{f.event || "-"}</td>
                <td className="px-4 py-3 text-gray-600">{f.viewThreshold != null ? f.viewThreshold.toLocaleString() : "-"}</td>
                <td className="px-4 py-3 text-gray-600">
                  {f.contentOwner ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-medium shrink-0">
                        {f.contentOwner.split(" ").map(n => n[0]).join("").slice(0, 2)}
                      </span>
                      <span className="truncate">{f.contentOwner}</span>
                    </span>
                  ) : "-"}
                </td>
                <td className="px-4 py-3 text-gray-600 max-w-[200px]">
                  {f.instructions ? (
                    <span className="line-clamp-2 text-xs">{f.instructions}</span>
                  ) : "-"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {f.repurposeTargetIds?.map((targetId) => {
                      const target = formats.find((ff) => ff.id === targetId);
                      return target ? (
                        <Badge key={targetId} variant="outline" className="text-xs">{target.name}</Badge>
                      ) : null;
                    })}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(f)}>Edit</Button>
                    <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => handleDelete(f.id)}>Delete</Button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredFormats.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                  {formats.length === 0
                    ? 'No formats yet. Click "Add Format" to create one.'
                    : `No formats for ${channelFilter}.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
