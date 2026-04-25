"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { AccountBadge, type AccountBadgeAccount } from "@/components/ui/account-badge";
import {
  PLATFORM_META,
  POST_TYPE_SHORT_LABEL,
  platformHasMultiplePostTypes,
  toPlatform,
} from "@/lib/platforms";
import { inferPostTypeFromUrl } from "@/lib/infer-post-type";
import type { PostType } from "@/lib/platform-field-schemas";

export interface PickerAccount extends AccountBadgeAccount {
  id: string;
  brandLabel: string;
  brandSlug: string;
  isActive: boolean;
  avatarUrl: string | null;
  syncedFromNotion: boolean;
}

interface AccountPostTypePickerProps {
  /** All pickable accounts. Inactive ones are hidden. */
  accounts: PickerAccount[];
  accountId: string | null;
  postType: PostType | string | null;
  onChange: (value: { accountId: string; postType: PostType | null }) => void;
  /** When set, the picker auto-suggests a post type matching the URL when
   *  the user hasn't manually picked one yet. Pass the item's published
   *  link so paste-a-URL workflows get post_type inference for free. */
  publishedLink?: string | null;
  /** Restrict the account list to one brand slug (e.g. on a brand-scoped
   *  create form). Omit to show all brands grouped. */
  brandSlug?: string | null;
  disabled?: boolean;
  className?: string;
}

/**
 * Cascading picker: Account first, then Post Type (only for platforms with
 * more than one — YouTube, Instagram). Clicking an account defaults the
 * post type to that platform's default; URL-based inference can override
 * the default when the item already has a published link.
 */
export function AccountPostTypePicker({
  accounts,
  accountId,
  postType,
  onChange,
  publishedLink,
  brandSlug,
  disabled,
  className,
}: AccountPostTypePickerProps) {
  const [accountPopoverOpen, setAccountPopoverOpen] = useState(false);
  const [postTypePopoverOpen, setPostTypePopoverOpen] = useState(false);
  // Track whether the user has manually touched the post-type this session.
  // URL-based inference only fires while this is false — otherwise a URL
  // change would silently clobber an explicit user choice.
  const [postTypeTouched, setPostTypeTouched] = useState(false);

  const visibleAccounts = useMemo(() => {
    const active = accounts.filter((a) => a.isActive);
    if (!brandSlug) return active;
    return active.filter((a) => a.brandSlug === brandSlug);
  }, [accounts, brandSlug]);

  const selected = accountId ? accounts.find((a) => a.id === accountId) ?? null : null;
  const platform = selected ? toPlatform(selected.platform) : null;

  // Group accounts by brand for the popover list. Order: brand label alpha,
  // then platform canonical order, then handle alpha.
  const grouped = useMemo(() => {
    const byBrand = new Map<string, PickerAccount[]>();
    for (const a of visibleAccounts) {
      if (!byBrand.has(a.brandLabel)) byBrand.set(a.brandLabel, []);
      byBrand.get(a.brandLabel)!.push(a);
    }
    return Array.from(byBrand.entries())
      .map(([brand, list]) => [
        brand,
        list.sort(
          (a, b) =>
            a.platform.localeCompare(b.platform) ||
            a.handle.localeCompare(b.handle)
        ),
      ] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [visibleAccounts]);

  // URL-driven post-type inference. Fires only when (a) we have an account
  // selected, (b) the URL's implied post type matches that account's
  // platform, and (c) the user hasn't already picked a post type manually.
  useEffect(() => {
    if (!selected || postTypeTouched) return;
    const inferred = inferPostTypeFromUrl(publishedLink);
    if (!inferred) return;
    const platformOfInferred = inferred.startsWith("youtube_") ? "youtube"
      : inferred.startsWith("instagram_") ? "instagram"
      : inferred;
    if (platformOfInferred !== selected.platform) return;
    if (postType === inferred) return;
    onChange({ accountId: selected.id, postType: inferred });
  }, [publishedLink, selected, postType, postTypeTouched, onChange]);

  function selectAccount(next: PickerAccount) {
    setAccountPopoverOpen(false);
    // When the user changes account, reset the post-type-touched flag so
    // URL inference can run against the new platform. If the URL implies
    // a post type that fits, this effect fires on the next render; else
    // we fall back to the platform's default.
    setPostTypeTouched(false);
    const urlInferred = inferPostTypeFromUrl(publishedLink);
    const urlPlatform = urlInferred?.startsWith("youtube_") ? "youtube"
      : urlInferred?.startsWith("instagram_") ? "instagram"
      : urlInferred ?? null;
    const nextPostType: PostType | null =
      urlInferred && urlPlatform === next.platform
        ? urlInferred
        : PLATFORM_META[toPlatform(next.platform)].defaultPostType;
    onChange({ accountId: next.id, postType: nextPostType });
  }

  function selectPostType(next: PostType) {
    setPostTypePopoverOpen(false);
    setPostTypeTouched(true);
    if (!selected) return;
    onChange({ accountId: selected.id, postType: next });
  }

  const platformPostTypes = platform ? PLATFORM_META[platform].postTypes : [];
  const showPostTypeControl =
    platform != null && platformHasMultiplePostTypes(platform);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* Account selector */}
      <Popover open={accountPopoverOpen} onOpenChange={setAccountPopoverOpen}>
        <PopoverTrigger
          disabled={disabled}
          className={cn(
            "flex h-9 min-w-0 items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
            showPostTypeControl ? "flex-1" : "w-full"
          )}
        >
          {selected ? (
            <AccountBadge
              account={selected}
              // no post-type suffix in the trigger — the second control
              // next to us shows it already
              variant="compact"
              className="border-none bg-transparent px-0 py-0 text-sm"
              size={14}
            />
          ) : (
            <span className="text-muted-foreground">Select account…</span>
          )}
          <svg
            className="ml-2 h-4 w-4 shrink-0 opacity-50"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m7 15 5 5 5-5" />
            <path d="m7 9 5-5 5 5" />
          </svg>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search accounts…" />
            <CommandList>
              <CommandEmpty>No accounts found.</CommandEmpty>
              {grouped.map(([brandLabel, list]) => (
                <CommandGroup key={brandLabel} heading={brandLabel}>
                  {list.map((a) => (
                    <CommandItem
                      key={a.id}
                      // Indexing value for typeahead — we want search to
                      // hit the handle AND the platform name.
                      value={`${a.handle} ${a.platform} ${a.displayName ?? ""}`}
                      onSelect={() => selectAccount(a)}
                    >
                      <span className="flex items-center gap-2 w-full">
                        <PlatformIcon platform={a.platform} size={14} />
                        <span className="text-sm font-medium">@{a.handle}</span>
                        {a.displayName && a.displayName !== a.handle && (
                          <span className="text-xs text-muted-foreground truncate">
                            {a.displayName}
                          </span>
                        )}
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                          {PLATFORM_META[toPlatform(a.platform)].label}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Post-type selector — only for platforms with multiple post types. */}
      {showPostTypeControl && (
        <Popover open={postTypePopoverOpen} onOpenChange={setPostTypePopoverOpen}>
          <PopoverTrigger
            disabled={disabled}
            className="flex h-9 shrink-0 items-center gap-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs hover:bg-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-muted-foreground text-xs">as</span>
            <span className="font-medium">
              {postType && POST_TYPE_SHORT_LABEL[postType as PostType]
                ? POST_TYPE_SHORT_LABEL[postType as PostType]
                : "—"}
            </span>
            <svg
              className="ml-1 h-3 w-3 shrink-0 opacity-50"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="end">
            <div className="flex flex-col">
              {platformPostTypes.map((pt) => {
                const isActive = postType === pt;
                return (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => selectPostType(pt)}
                    className={cn(
                      "text-left px-2 py-1.5 rounded-sm text-sm hover:bg-accent",
                      isActive && "bg-accent font-medium"
                    )}
                  >
                    {POST_TYPE_SHORT_LABEL[pt]}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
