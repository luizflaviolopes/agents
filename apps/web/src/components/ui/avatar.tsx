import * as React from "react";
import { cn } from "@/lib/utils";

/** Simple initials avatar. */
function Avatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const initials = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div
      className={cn(
        "flex size-8 shrink-0 select-none items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary",
        className,
      )}
    >
      {initials || "?"}
    </div>
  );
}

export { Avatar };
