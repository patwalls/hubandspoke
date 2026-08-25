"use client";

import * as React from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
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
import { UserChip, personDisplay } from "./user-chip";

type User = { id: string; name: string | null; email: string; avatarUrl: string | null };

export function UserCombobox({
  value,
  onValueChange,
  users,
  disabled,
  triggerClassName,
  chipSize = "sm",
  placeholder = "Select an editor…",
}: {
  value: string;
  onValueChange: (value: string) => void;
  users: User[];
  disabled?: boolean;
  triggerClassName?: string;
  chipSize?: "sm" | "xs";
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selectedUser = users.find((u) => u.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label="Assignee"
        className={cn(
          "flex items-center justify-between gap-1.5 min-w-0 text-left",
          triggerClassName,
        )}
      >
        {selectedUser ? (
          <UserChip user={selectedUser} size={chipSize} />
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground opacity-70" />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No users found.</CommandEmpty>
            <CommandGroup>
              {users.map((u) => {
                const { name } = personDisplay(u);
                return (
                  <CommandItem
                    key={u.id}
                    value={`${name} ${u.email}`}
                    onSelect={() => {
                      onValueChange(u.id);
                      setOpen(false);
                    }}
                  >
                    <UserChip user={u} />
                    {value === u.id && (
                      <CheckIcon className="ml-auto size-4 shrink-0" />
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
