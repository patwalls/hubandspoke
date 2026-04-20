import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { UserManagement } from "@/components/settings/user-management";

export const metadata: Metadata = { title: "Users · Settings" };

export default async function UsersSettingsPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "admin") {
    return (
      <div className="rounded-lg border border-border bg-card p-6 max-w-xl">
        <h2 className="text-base font-semibold text-foreground">
          Admins only
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Only admins can manage users. Contact an admin if you need access.
        </p>
      </div>
    );
  }

  return <UserManagement currentUserId={session.user.id} />;
}
