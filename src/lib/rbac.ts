export type Role = "admin" | "creator";

export const ROLES = ["admin", "creator"] as const satisfies readonly Role[];

export function isRole(value: unknown): value is Role {
  return value === "admin" || value === "creator";
}
