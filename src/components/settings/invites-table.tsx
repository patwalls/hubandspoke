"use client";

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
import type { Role } from "@/lib/rbac";

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export type Invite = {
  id: string;
  email: string;
  role: Role;
  invitedByEmail: string | null;
  invitedByName: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: InviteStatus;
};

interface Props {
  invites: Invite[] | null;
  onChanged: () => void;
  onError: (msg: string) => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function statusVariant(s: InviteStatus): "default" | "secondary" | "outline" | "destructive" {
  if (s === "pending") return "default";
  if (s === "accepted") return "secondary";
  if (s === "expired") return "outline";
  return "destructive";
}

export function InvitesTable({ invites, onChanged, onError }: Props) {
  async function resend(id: string) {
    try {
      const res = await fetch(`/api/invites/${id}/resend`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to resend");
      }
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to resend");
    }
  }

  async function revoke(id: string) {
    try {
      const res = await fetch(`/api/invites/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to revoke");
      }
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to revoke");
    }
  }

  if (invites === null) {
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
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Invited by</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[160px] text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invites.map((i) => (
            <TableRow key={i.id}>
              <TableCell className="text-foreground">{i.email}</TableCell>
              <TableCell>
                <Badge variant={i.role === "admin" ? "default" : "secondary"}>
                  {i.role}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {i.invitedByName || i.invitedByEmail || "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(i.createdAt)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(i.expiresAt)}
              </TableCell>
              <TableCell>
                <Badge variant={statusVariant(i.status)}>{i.status}</Badge>
              </TableCell>
              <TableCell className="text-right">
                {i.status === "pending" && (
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => resend(i.id)}
                    >
                      Resend
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revoke(i.id)}
                    >
                      Revoke
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
          {invites.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={7}
                className="text-center text-muted-foreground text-xs py-6"
              >
                No invites yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
