import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { DashboardNav } from "@/components/dashboard/nav";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export default async function FormatsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const [userRow] = session.user.id
    ? await db
        .select({ name: users.name, avatarUrl: users.avatarUrl })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1)
    : [];

  return (
    <div className="min-h-screen bg-gray-50">
      <DashboardNav
        userEmail={session.user.email || ""}
        userName={userRow?.name ?? null}
        userAvatarUrl={userRow?.avatarUrl ?? null}
      />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {children}
      </main>
    </div>
  );
}
