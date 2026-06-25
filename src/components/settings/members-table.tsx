"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { Role } from "@/lib/rbac";
import type { BrandOption } from "@/components/settings/user-management";

export type Member = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  avatarUrl: string | null;
  invitedBy: string | null;
  createdAt: string;
  dailyScorecardEmailEnabled: boolean;
  brandIds: string[];
};

interface Props {
  members: Member[] | null;
  brands: BrandOption[];
  currentUserId: string;
  onChanged: () => void;
  onError: (msg: string) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ChannelBadges({
  brandIds,
  brands,
}: {
  brandIds: string[];
  brands: BrandOption[];
}) {
  if (!brandIds.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {brandIds.map((id) => {
        const brand = brands.find((b) => b.id === id);
        return (
          <Badge key={id} variant="secondary" className="text-xs">
            {brand?.label ?? id}
          </Badge>
        );
      })}
    </div>
  );
}

function EditMemberDialog({
  member,
  brands,
  onSave,
  onClose,
}: {
  member: Member;
  brands: BrandOption[];
  onSave: (brandIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(member.brandIds)
  );
  const [saving, setSaving] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    await onSave([...selected]);
    setSaving(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit member</DialogTitle>
          <DialogDescription>
            Update settings for {member.name || member.email}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <p className="text-sm font-medium">Channels</p>
          <p className="text-xs text-muted-foreground">
            Which brands this person is working on.
          </p>
        </div>

        <div className="space-y-2 max-h-64 overflow-y-auto">
          {brands.length === 0 && (
            <p className="text-xs text-muted-foreground">No brands found.</p>
          )}
          {brands.map((b) => (
            <label
              key={b.id}
              className="flex items-center gap-3 cursor-pointer rounded-md px-2 py-1.5 hover:bg-muted/50"
            >
              <input
                type="checkbox"
                checked={selected.has(b.id)}
                onChange={() => toggle(b.id)}
                className="h-4 w-4 accent-primary"
              />
              <span className="text-sm">{b.label}</span>
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MembersTable({
  members,
  brands,
  currentUserId,
  onChanged,
  onError,
}: Props) {
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [editTarget, setEditTarget] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);

  async function changeRole(member: Member, role: Role) {
    try {
      const res = await fetch(`/api/users/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update role");
      }
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update role");
    }
  }

  async function setScorecardEnabled(member: Member, enabled: boolean) {
    try {
      const res = await fetch(`/api/users/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyScorecardEmailEnabled: enabled }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update scorecard preference");
      }
      onChanged();
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to update scorecard preference"
      );
    }
  }

  async function saveChannels(member: Member, brandIds: string[]) {
    try {
      const res = await fetch(`/api/users/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update channels");
      }
      setEditTarget(null);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update channels");
    }
  }

  async function removeMember(member: Member) {
    setBusy(true);
    try {
      const res = await fetch(`/api/users/${member.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to remove user");
      }
      setRemoveTarget(null);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to remove user");
    } finally {
      setBusy(false);
    }
  }

  if (members === null) {
    return (
      <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <>
      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Channels</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead
                className="text-center"
                title="Receives the daily publish-count scorecard email at 9am ET."
              >
                Daily scorecard
              </TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => {
              const isSelf = m.id === currentUserId;
              return (
                <TableRow key={m.id}>
                  <TableCell className="text-foreground">
                    {m.name || "—"}
                    {isSelf && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (you)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.email}
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.role === "admin" ? "default" : "secondary"}>
                      {m.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ChannelBadges brandIds={m.brandIds} brands={brands} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(m.createdAt)}
                  </TableCell>
                  <TableCell className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`Send daily scorecard to ${m.email}`}
                      checked={m.dailyScorecardEmailEnabled}
                      onChange={(e) =>
                        setScorecardEnabled(m, e.target.checked)
                      }
                      className="h-4 w-4 cursor-pointer accent-primary"
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="sm">
                            ···
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => setEditTarget(m)}
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {m.role === "creator" ? (
                          <DropdownMenuItem
                            onClick={() => changeRole(m, "admin")}
                            disabled={isSelf}
                          >
                            Make admin
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() => changeRole(m, "creator")}
                            disabled={isSelf}
                          >
                            Demote to creator
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setRemoveTarget(m)}
                          disabled={isSelf}
                        >
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
            {members.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-muted-foreground text-xs py-6"
                >
                  No users yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {editTarget && (
        <EditMemberDialog
          member={editTarget}
          brands={brands}
          onSave={(ids) => saveChannels(editTarget, ids)}
          onClose={() => setEditTarget(null)}
        />
      )}

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove user?</DialogTitle>
            <DialogDescription>
              {removeTarget
                ? `${removeTarget.email} will lose access immediately.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeTarget && removeMember(removeTarget)}
              disabled={busy}
            >
              {busy ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
