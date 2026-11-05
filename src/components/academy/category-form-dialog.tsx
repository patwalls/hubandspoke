"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AcademyCategory } from "@/lib/academy/queries";

/** Add, rename or delete an Academy category (delete only when it's empty). */
export function CategoryFormDialog({
  category,
  onClose,
}: {
  category?: Pick<AcademyCategory, "id" | "name" | "description"> & { videoCount: number };
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(category?.name ?? "");
  const [description, setDescription] = useState(category?.description ?? "");
  const [saving, setSaving] = useState(false);

  async function send(method: "POST" | "PATCH" | "DELETE") {
    setSaving(true);
    try {
      const res = await fetch(category ? `/api/academy/categories/${category.id}` : "/api/academy/categories", {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify({ name, description }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      toast.success(method === "DELETE" ? "Category deleted" : category ? "Category updated" : "Category added");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{category ? "Edit category" : "Add a category"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily Workflow" autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label>Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional — one line under the category name" />
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          {category ? (
            <Button
              variant="destructive"
              disabled={saving || category.videoCount > 0}
              title={category.videoCount > 0 ? "Move or delete this category's videos first" : undefined}
              onClick={() => send("DELETE")}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => (name.trim() ? send(category ? "PATCH" : "POST") : toast.error("Name the category"))} disabled={saving}>
              {saving ? "Saving…" : category ? "Save" : "Add category"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
