"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trackUsage } from "@/lib/usage/track";

/** On/off for one of your own emails. Defaults are the My Work morning email
 *  (my-day M4); the Monday winners email passes its own endpoint, name and
 *  usage marks. */
export function DigestToggle({
  enabled,
  endpoint = "/api/my-work/digest",
  label = "Morning email",
  mark = "my-work:digest",
}: {
  enabled: boolean;
  endpoint?: string;
  label?: string;
  mark?: string;
}) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);

  async function flip() {
    const next = !on;
    setBusy(true);
    trackUsage(next ? `${mark}-on` : `${mark}-off`);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      setOn(next);
      toast.success(next ? `${label} is on` : `${label} is off`);
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
        {label} is <strong>{on ? "on" : "off"}</strong>
      </span>
      <Button size="sm" variant={on ? "outline" : "default"} disabled={busy} onClick={flip}>
        {on ? "Turn off" : "Turn on"}
      </Button>
    </div>
  );
}
