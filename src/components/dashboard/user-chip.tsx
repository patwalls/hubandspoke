const AVATAR_COLORS = [
  "bg-rose-200 text-rose-800",
  "bg-amber-200 text-amber-800",
  "bg-emerald-200 text-emerald-800",
  "bg-sky-200 text-sky-800",
  "bg-violet-200 text-violet-800",
  "bg-pink-200 text-pink-800",
  "bg-teal-200 text-teal-800",
];

export function personDisplay(user: { name: string | null; email: string }): {
  name: string;
  initials: string;
  colorClass: string;
} {
  const source = (user.name?.trim() || user.email.split("@")[0] || "").trim();
  const words = source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase());
  const name = user.name?.trim() || words.join(" ") || user.email;
  const initials =
    words.map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() ||
    (user.email[0] ?? "?").toUpperCase();
  let hash = 0;
  const seed = user.email || name;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const colorClass = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  return { name, initials, colorClass };
}

export function UserChip({
  user,
  size = "sm",
}: {
  user: { name: string | null; email: string; avatarUrl: string | null };
  size?: "sm" | "xs";
}) {
  const { name, initials, colorClass } = personDisplay(user);
  const dim = size === "xs" ? "w-5 h-5 text-[9px]" : "w-6 h-6 text-[10px]";
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      {user.avatarUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={user.avatarUrl}
          alt=""
          className={`${dim} rounded-full object-cover shrink-0 bg-accent`}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          className={`${dim} rounded-full flex items-center justify-center font-semibold shrink-0 ${colorClass}`}
        >
          {initials}
        </span>
      )}
      <span className="truncate">{name}</span>
    </span>
  );
}
