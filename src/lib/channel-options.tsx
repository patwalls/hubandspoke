import { AccountAvatar } from "@/components/ui/account-avatar";
import {
  POST_TYPE_SHORT_LABEL,
  platformHasMultiplePostTypes,
  toPlatform,
} from "@/lib/platforms";
import type { PostType } from "@/lib/platform-field-schemas";

export interface ChannelOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

/**
 * The minimum shape `buildChannelOptions` needs. Any source carrying
 * `(accountId, postType, account)` — ProductionItem, FormatChannelWithAccount,
 * an ad-hoc join — satisfies this without adapters.
 */
export interface ChannelSource {
  accountId: string | null;
  postType: string | null;
  account:
    | {
        platform: string;
        handle: string;
        avatarUrl?: string | null;
      }
    | null;
}

/**
 * Keys a channel option by the same (accountId, postType) pair the source
 * carries — so filtering is a direct equality check instead of a legacy
 * platform-string substring match. Use `matchesChannel(source, value)` to
 * filter rows against the selected option.
 *
 * Options are derived from the sources themselves, so the dropdown only
 * lists channels that actually have content in the current view — no
 * stale "Twitter" or hand-entered variants.
 */
export function buildChannelOptions(
  sources: Iterable<ChannelSource>,
  allLabel = "All channels"
): ChannelOption[] {
  const seen = new Map<
    string,
    {
      accountId: string;
      postType: string | null;
      account: NonNullable<ChannelSource["account"]>;
    }
  >();
  for (const source of sources) {
    if (!source.account || !source.accountId) continue;
    const key = channelKey(source.accountId, source.postType);
    if (!seen.has(key)) {
      seen.set(key, {
        accountId: source.accountId,
        postType: source.postType,
        account: source.account,
      });
    }
  }

  const sorted = Array.from(seen.entries()).sort(([, a], [, b]) => {
    const left = `${a.account.platform} ${a.account.handle} ${a.postType ?? ""}`;
    const right = `${b.account.platform} ${b.account.handle} ${b.postType ?? ""}`;
    return left.localeCompare(right);
  });

  return [
    { value: "all", label: allLabel },
    ...sorted.map(([key, v]) => {
      const p = toPlatform(v.account.platform);
      const suffix =
        v.postType && platformHasMultiplePostTypes(p)
          ? ` · ${POST_TYPE_SHORT_LABEL[v.postType as PostType] ?? v.postType}`
          : "";
      return {
        value: key,
        label: `@${v.account.handle}${suffix}`,
        icon: (
          <AccountAvatar
            avatarUrl={v.account.avatarUrl ?? null}
            platform={v.account.platform}
            handle={v.account.handle}
            size={18}
          />
        ),
      };
    }),
  ];
}

export function channelKey(
  accountId: string | null,
  postType: string | null
): string {
  return `${accountId ?? ""}|${postType ?? ""}`;
}

export function matchesChannel(
  source: ChannelSource,
  value: string
): boolean {
  if (value === "all") return true;
  return channelKey(source.accountId, source.postType) === value;
}
