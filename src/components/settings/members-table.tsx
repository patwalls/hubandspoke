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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import type { Role } from "@/lib/rbac";
import type { BrandOption } from "@/components/settings/user-management";

export type ContentRole = "producer" | "curator" | "member";

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
  contentRole: ContentRole | null;
  /** Set when deactivated — can't sign in, gets no email; history kept. */
  deactivatedAt: string | null;
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

const CONTENT_ROLE_STYLES: Record<ContentRole, string> = {
  producer: "bg-emerald-100 text-emerald-700 border-emerald-200",
  curator: "bg-blue-100 text-blue-700 border-blue-200",
  member: "bg-secondary text-secondary-foreground border-transparent",
};

function ContentRoleBadge({ role }: { role: ContentRole | null }) {
  if (!role) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge className={CONTENT_ROLE_STYLES[role]}>
      {role.charAt(0).toUpperCase() + role.slice(1)}
    </Badge>
  );
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
  isSelf,
  onSave,
  onClose,
}: {
  member: Member;
  brands: BrandOption[];
  /** You can't change your own permission level (the API refuses it too). */
  isSelf: boolean;
  onSave: (data: { role: Role; brandIds: string[]; contentRole: ContentRole | null }) => Promise<void>;
  onClose: () => void;
}) {
  const [role, setRole] = useState<Role>(member.role);
  const [selected, setSelected] = useState<Set<string>>(new Set(member.brandIds));
  const [contentRole, setContentRole] = useState<ContentRole | "">(
    member.contentRole ?? ""
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
    await onSave({
      role,
      brandIds: [...selected],
      contentRole: contentRole || null,
    });
    setSaving(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update permissions</DialogTitle>
          <DialogDescription>
            What {member.name || member.email} can change in Hub &amp; Spoke.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Permission</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as Role)}
              disabled={isSelf}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{role === "admin" ? "Admin" : "Creator"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin — can edit every brand</SelectItem>
                <SelectItem value="creator">Creator — can edit only the brands below</SelectItem>
              </SelectContent>
            </Select>
            {isSelf && (
              <p className="text-xs text-muted-foreground">
                You can&apos;t change your own permission.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Role</Label>
            <Select
              value={contentRole}
              onValueChange={(v) => setContentRole(v as ContentRole | "")}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="No role set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="producer">Producer</SelectItem>
                <SelectItem value="curator">Curator</SelectItem>
                <SelectItem value="member">Member</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className={role === "admin" ? "space-y-2 opacity-60" : "space-y-2"}>
            <Label>Brands they can edit</Label>
            <p className="text-xs text-muted-foreground">
              Everyone can view every brand. Creators can only make changes on
              the brands checked here; admins can edit all brands.
            </p>
            <div className="space-y-1 max-h-48 overflow-y-auto rounded-md border border-input bg-background px-3 py-2">
              {brands.length === 0 && (
                <p className="text-xs text-muted-foreground py-1">No brands found.</p>
              )}
              {brands.map((b) => (
                <label
                  key={b.id}
                  className="flex items-center gap-3 cursor-pointer rounded px-1 py-1.5 hover:bg-muted/50"
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
          </div>
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
  const [deactivateTarget, setDeactivateTarget] = useState<Member | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function saveMember(
    member: Member,
    data: { role: Role; brandIds: string[]; contentRole: ContentRole | null }
  ) {
    try {
      const res = await fetch(`/api/users/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: data.role,
          brandIds: data.brandIds,
          contentRole: data.contentRole,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update member");
      }
      setEditTarget(null);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update member");
    }
  }

  // Deactivate / reactivate. Never deletes the row (their posts keep their
  // editor) and never emails the person.
  async function setDeactivated(member: Member, deactivated: boolean) {
    setBusy(true);
    setDeactivateError(null);
    try {
      const res = await fetch(`/api/users/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deactivated }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update user");
      }
      setDeactivateTarget(null);
      onChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update user";
      // Shown inside the dialog when it's open — the page-level error sits
      // behind the overlay where nobody sees it.
      if (deactivated) setDeactivateError(message);
      else onError(message);
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
              <TableHead>Permissions</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Can edit</TableHead>
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
            {[...members]
              .sort((a, b) => Number(!!a.deactivatedAt) - Number(!!b.deactivatedAt))
              .map((m) => {
              const isSelf = m.id === currentUserId;
              return (
                <TableRow key={m.id} className={m.deactivatedAt ? "opacity-60" : undefined}>
                  <TableCell className="text-foreground">
                    {m.name || "—"}
                    {isSelf && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (you)
                      </span>
                    )}
                    {m.deactivatedAt && (
                      <Badge variant="outline" className="ml-2">
                        Deactivated
                      </Badge>
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
                    <ContentRoleBadge role={m.contentRole} />
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
                        <DropdownMenuItem onClick={() => setEditTarget(m)}>
                          Update permissions
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {m.deactivatedAt ? (
                          <DropdownMenuItem onClick={() => setDeactivated(m, false)} disabled={busy}>
                            Reactivate
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => {
                              setDeactivateError(null);
                              setDeactivateTarget(m);
                            }}
                            disabled={isSelf}
                          >
                            Deactivate
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
            {members.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
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
          isSelf={editTarget.id === currentUserId}
          onSave={(data) => saveMember(editTarget, data)}
          onClose={() => setEditTarget(null)}
        />
      )}

      <Dialog
        open={deactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivateTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Deactivate {deactivateTarget?.name || deactivateTarget?.email}?
            </DialogTitle>
            <DialogDescription>
              They won&apos;t be able to sign in, and if they&apos;re signed in now they&apos;ll lose
              access on their next page load. Their posts, comments and history stay as they are.
              They won&apos;t be notified, and you can reactivate them any time.
            </DialogDescription>
          </DialogHeader>
          {deactivateError && (
            <p className="text-sm text-destructive">{deactivateError}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeactivateTarget(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deactivateTarget && setDeactivated(deactivateTarget, true)}
              disabled={busy}
            >
              {busy ? "Deactivating…" : "Deactivate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
