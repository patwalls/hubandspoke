import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import type { Role } from "@/lib/rbac";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
    } & DefaultSession["user"];
  }

  interface User {
    id?: string;
    role?: Role;
  }
}

type TokenShape = { id?: string; role?: Role; sub?: string };

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (creds) => {
        if (!creds?.email || !creds?.password) return null;
        const email = String(creds.email).toLowerCase().trim();
        const password = String(creds.password);
        const [user] = await db
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`)
          .limit(1);
        if (!user || !user.passwordHash) return null;
        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          role: user.role as Role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Keep this callback free of DB I/O — it runs in Edge middleware where
      // the postgres-js driver can't load. Role is baked in at sign-in; role
      // changes take effect on next login.
      const t = token as TokenShape;
      if (user?.id) {
        t.id = user.id;
        if (user.role) t.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      const t = token as TokenShape;
      if (t.id && session.user) {
        session.user.id = t.id;
        session.user.role = (t.role ?? "creator") as Role;
      }
      return session;
    },
  },
});
