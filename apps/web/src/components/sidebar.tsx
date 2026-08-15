"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Boxes,
  Check,
  ChevronsUpDown,
  FolderKanban,
  LogOut,
  Menu,
  Plus,
  Settings,
  X,
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

interface SidebarProps {
  projects: Project[];
  email: string;
  displayName: string | null;
}

/**
 * App navigation shell: a fixed sidebar on md+ screens, and on mobile a
 * top bar with a hamburger that opens the same navigation as a drawer.
 */
export function Sidebar(props: SidebarProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Navigating closes the drawer.
  React.useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  return (
    <>
      {/* Mobile top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card/50 px-3 pt-[env(safe-area-inset-top)] md:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Open navigation"
        >
          <Menu className="size-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary/20">
            <Boxes className="size-4 text-primary" />
          </div>
          <span className="text-sm font-semibold tracking-tight">
            Agent Fleet
          </span>
        </div>
      </header>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-card pt-[env(safe-area-inset-top)] shadow-2xl">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="absolute right-2 top-[calc(env(safe-area-inset-top)+0.75rem)] flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Close navigation"
            >
              <X className="size-4" />
            </button>
            <SidebarContent {...props} />
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-card/50 md:flex">
        <SidebarContent {...props} />
      </aside>
    </>
  );
}

function SidebarContent({ projects, email, displayName }: SidebarProps) {
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
    <>
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
      <div className="border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
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
    </>
  );
}
