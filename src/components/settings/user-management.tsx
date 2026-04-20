"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MembersTable, type Member } from "@/components/settings/members-table";
import { InvitesTable, type Invite } from "@/components/settings/invites-table";
import { InviteDialog } from "@/components/settings/invite-dialog";

export function UserManagement({ currentUserId }: { currentUserId: string }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const loadMembers = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      if (!res.ok) throw new Error("Failed to load users");
      const json = await res.json();
      setMembers(json.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    }
  }, []);

  const loadInvites = useCallback(async () => {
    try {
      const res = await fetch("/api/invites");
      if (!res.ok) throw new Error("Failed to load invites");
      const json = await res.json();
      setInvites(json.invites ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invites");
    }
  }, []);

  useEffect(() => {
    loadMembers();
    loadInvites();
  }, [loadMembers, loadInvites]);

  return (
    <div className="space-y-8 max-w-4xl">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Members</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Everyone with access to Hub &amp; Spoke.
            </p>
          </div>
          <Button onClick={() => setInviteOpen(true)}>Invite member</Button>
        </div>
        <MembersTable
          members={members}
          currentUserId={currentUserId}
          onChanged={loadMembers}
          onError={setError}
        />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Invites</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pending and past invites.
          </p>
        </div>
        <InvitesTable
          invites={invites}
          onChanged={loadInvites}
          onError={setError}
        />
      </section>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={() => {
          loadInvites();
        }}
      />
    </div>
  );
}
