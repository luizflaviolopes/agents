"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Boxes,
  Check,
  ChevronsUpDown,
  FolderKanban,
  LogOut,
  Plus,
  Settings,
} from "lucide-react";
import type { Project } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import {
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
} from "@/components/ui/dropdown-menu";

export function Sidebar({
  projects,
  email,
  displayName,
}: {
  projects: Project[];
  email: string;
  displayName: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const currentProject = projects.find((p) =>
    pathname.startsWith(`/projects/${p.id}`),
  );

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const navItems = [
    { href: "/projects", label: "Projects", icon: FolderKanban },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border bg-card/50">
      <div className="flex items-center gap-2 px-4 pb-2 pt-5">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary/20">
          <Boxes className="size-4 text-primary" />
        </div>
        <span className="text-sm font-semibold tracking-tight">
          Agent Fleet
        </span>
      </div>

      {/* Project switcher */}
      <div className="px-3 pt-3">
        <Dropdown
          className="w-full"
          contentClassName="w-[13.5rem]"
          trigger={
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm shadow-sm transition-colors hover:bg-accent"
            >
              <span className="truncate">
                {currentProject ? currentProject.name : "Select project"}
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          }
        >
          <DropdownLabel>Projects</DropdownLabel>
          {projects.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              No projects yet
            </div>
          )}
          {projects.map((project) => (
            <DropdownItem
              key={project.id}
              onClick={() => router.push(`/projects/${project.id}`)}
            >
              <span className="flex-1 truncate">{project.name}</span>
              {currentProject?.id === project.id && <Check />}
            </DropdownItem>
          ))}
          <DropdownSeparator />
          <DropdownItem onClick={() => router.push("/projects?new=1")}>
            <Plus />
            New project
          </DropdownItem>
        </Dropdown>
      </div>

      {/* Nav */}
      <nav className="mt-4 flex flex-1 flex-col gap-0.5 px-3">
        {navItems.map((item) => {
          const active =
            item.href === "/projects"
              ? pathname === "/projects" || pathname.startsWith("/projects/")
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* User menu */}
      <div className="border-t border-border p-3">
        <Dropdown
          className="w-full"
          align="start"
          contentClassName="bottom-full mb-1.5 mt-0 w-[13.5rem]"
          trigger={
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
            >
              <Avatar name={displayName || email} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {displayName || email.split("@")[0]}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {email}
                </div>
              </div>
            </button>
          }
        >
          <DropdownItem onClick={() => router.push("/settings")}>
            <Settings />
            Settings
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem onClick={signOut}>
            <LogOut />
            Sign out
          </DropdownItem>
        </Dropdown>
      </div>
    </aside>
  );
}
