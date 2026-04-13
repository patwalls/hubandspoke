import { redirect } from "next/navigation";
import { DEFAULT_BRAND } from "@/lib/config/brands";

export default function RootPage() {
  redirect(`/${DEFAULT_BRAND}`);
}
