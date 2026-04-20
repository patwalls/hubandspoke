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

export type Member = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  avatarUrl: string | null;
  invitedBy: string | null;
  createdAt: string;
};

interface Props {
  members: Member[] | null;
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

export function MembersTable({
  members,
  currentUserId,
  onChanged,
  onError,
}: Props) {
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
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
    <div className="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Joined</TableHead>
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
                <TableCell className="text-muted-foreground">
                  {formatDate(m.createdAt)}
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
                colSpan={5}
                className="text-center text-muted-foreground text-xs py-6"
              >
                No users yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

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
    </div>
  );
}
