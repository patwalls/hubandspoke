"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

interface FormatRow {
  id: string;
  name: string;
  channels: string[];
  event: string | null;
  repurposeTargetIds: string[];
}

const ALL_CHANNELS = [
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

export default function FormatsPage() {
  const [formats, setFormats] = useState<FormatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingFormat, setEditingFormat] = useState<FormatRow | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>("all");

  // Form state
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [event, setEvent] = useState("");
  const [repurposeTargetIds, setRepurposeTargetIds] = useState<string[]>([]);

  const fetchFormats = useCallback(async () => {
    try {
      const res = await fetch("/api/formats");
      const data = await res.json();
      setFormats(data);
    } catch (err) {
      console.error("Failed to fetch formats:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFormats();
  }, [fetchFormats]);

  function openCreate() {
    setEditingFormat(null);
    setName("");
    setChannels([]);
    setEvent("");
    setRepurposeTargetIds([]);
    setDialogOpen(true);
  }

  function openEdit(f: FormatRow) {
    setEditingFormat(f);
    setName(f.name);
    setChannels(f.channels || []);
    setEvent(f.event || "");
    setRepurposeTargetIds(f.repurposeTargetIds || []);
    setDialogOpen(true);
  }

  async function handleSave() {
    const body = {
      id: editingFormat?.id,
      name,
      channels,
      event: event || null,
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

  const filteredFormats =
    channelFilter === "all"
      ? formats
      : formats.filter((f) => f.channels?.includes(channelFilter));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        Loading formats...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Formats</h1>
          <p className="text-sm text-gray-500">
            Manage content format templates and repurpose chains.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger>
            <Button onClick={openCreate}>Add Format</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
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

      <div className="flex items-center gap-2">
        <Label className="text-sm text-gray-600">Filter by channel:</Label>
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="w-[200px]">
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

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Name
              </th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Channels
              </th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Event
              </th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Repurpose Targets
              </th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredFormats.map((f) => (
              <tr
                key={f.id}
                className="border-b border-gray-100 hover:bg-gray-50"
              >
                <td className="px-4 py-3 font-medium text-gray-900">
                  {f.name}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {f.channels?.map((ch) => (
                      <Badge key={ch} variant="secondary" className="text-xs">
                        {ch}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-600">{f.event || "-"}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {f.repurposeTargetIds?.map((targetId) => {
                      const target = formats.find((ff) => ff.id === targetId);
                      return target ? (
                        <Badge
                          key={targetId}
                          variant="outline"
                          className="text-xs"
                        >
                          {target.name}
                        </Badge>
                      ) : null;
                    })}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(f)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:text-red-700"
                      onClick={() => handleDelete(f.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredFormats.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-gray-400"
                >
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
