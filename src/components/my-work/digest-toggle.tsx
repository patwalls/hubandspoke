"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trackUsage } from "@/lib/usage/track";

/** On/off for your own My Work morning email (my-day M4). */
export function DigestToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);

  async function flip() {
    const next = !on;
    setBusy(true);
    trackUsage(next ? "my-work:digest-on" : "my-work:digest-off");
    try {
      const res = await fetch("/api/my-work/digest", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      setOn(next);
      toast.success(next ? "Morning email is on" : "Morning email is off");
      router.refresh();
    } catch {
      toast.error("Couldn't save that — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-foreground" data-digest-state>
        Morning email is <strong>{on ? "on" : "off"}</strong>
      </span>
      <Button size="sm" variant={on ? "outline" : "default"} disabled={busy} onClick={flip}>
        {on ? "Turn off" : "Turn on"}
      </Button>
    </div>
  );
}
