"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { Role } from "@/lib/rbac";
import type { BrandOption } from "@/components/settings/user-management";
import type { ContentRole } from "@/components/settings/members-table";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  brands: BrandOption[];
}

export function InviteDialog({ open, onOpenChange, onCreated, brands }: Props) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("creator");
  const [contentRole, setContentRole] = useState<ContentRole | "">("");
  const [selectedBrandIds, setSelectedBrandIds] = useState<Set<string>>(
    new Set()
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleBrand(id: string) {
    setSelectedBrandIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function reset() {
    setEmail("");
    setRole("creator");
    setContentRole("");
    setSelectedBrandIds(new Set());
    setError(null);
    setSubmitting(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          role,
          contentRole: contentRole || null,
          brandIds: [...selectedBrandIds],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to send invite");
      }
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              They&apos;ll receive an email with a link to join Hub &amp; Spoke.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              required
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-permission">Permissions</Label>
            <Select
              value={role}
              onValueChange={(v) => v && setRole(v as Role)}
            >
              <SelectTrigger id="invite-permission" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="creator">Creator</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Admins can invite and manage users. Creators have normal app
              access.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-content-role">Role</Label>
            <Select
              value={contentRole}
              onValueChange={(v) => setContentRole(v as ContentRole | "")}
            >
              <SelectTrigger id="invite-content-role" className="w-full">
                <SelectValue placeholder="No role set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="producer">Producer</SelectItem>
                <SelectItem value="curator">Curator</SelectItem>
                <SelectItem value="member">Member</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {brands.length > 0 && (
            <div className="space-y-2">
              <Label>Channels</Label>
              <div className="space-y-1 max-h-40 overflow-y-auto rounded-md border border-input bg-background px-3 py-2">
                {brands.map((b) => (
                  <label
                    key={b.id}
                    className="flex items-center gap-3 cursor-pointer rounded px-1 py-1 hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedBrandIds.has(b.id)}
                      onChange={() => toggleBrand(b.id)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="text-sm">{b.label}</span>
                  </label>
                ))}
              </div>
              {selectedBrandIds.size > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {[...selectedBrandIds].map((id) => {
                    const b = brands.find((br) => br.id === id);
                    return (
                      <Badge key={id} variant="secondary" className="text-xs">
                        {b?.label ?? id}
                      </Badge>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Sending…" : "Send invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
