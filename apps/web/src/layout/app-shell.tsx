import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { LogOut, Monitor, Moon, Search, Sun, SunMoon } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { type Theme, useTheme } from "@/lib/theme";
import { DatabaseBanner, HealthIndicator } from "./health";
import { NAV, sectionOf } from "./nav";

// Loaded on first use: most sessions never open it.
const CommandPalette = lazy(async () => ({ default: (await import("./command-palette")).CommandPalette }));

function useHotkeyOnce(done: boolean, open: () => void) {
  useEffect(() => {
    if (done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [done, open]);
}

function ThemeMenu() {
  const [theme, setTheme] = useTheme();
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Тема оформления" />}>
        <Icon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuLabel>Тема</DropdownMenuLabel>
          <DropdownMenuRadioItem value="system">Как в системе</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Светлая</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Тёмная</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ login, children }: { login: string; children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const section = sectionOf(pathname);
  const [palette, setPalette] = useState(false);
  const [paletteLoaded, setPaletteLoaded] = useState(false);
  const openPalette = () => {
    setPaletteLoaded(true);
    setPalette(true);
  };
  // Cmd+K before the palette is loaded: load it open; once loaded, it handles the shortcut itself.
  useHotkeyOnce(paletteLoaded, openPalette);
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    // reset, not invalidate: a refetch error keeps the previous data and the shell would stay
    onSuccess: () => queryClient.resetQueries({ queryKey: ["me"] }),
  });

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2.5 px-1.5 py-1">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
              <Monitor className="size-4" aria-hidden />
            </span>
            <span className="truncate text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">BAP</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {[false, true].map((frozen) => (
            <SidebarGroup key={String(frozen)} className={frozen ? "mt-auto" : undefined}>
              {frozen && <SidebarGroupLabel>Заморожено</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.filter((n) => ("frozen" in n) === frozen).map((n) => (
                    <SidebarMenuItem key={n.to}>
                      <SidebarMenuButton isActive={section.to === n.to} tooltip={n.label} render={<Link to={n.to} />} className={frozen ? "text-muted-foreground" : undefined}>
                        <n.icon aria-hidden />
                        <span>{n.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Выйти" onClick={() => logout.mutate()}>
                <LogOut aria-hidden />
                <span>Выйти</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <p className="truncate px-2 pb-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">Оператор {login}</p>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur">
          <SidebarTrigger aria-label="Свернуть меню" />
          <Separator orientation="vertical" className="mx-1 h-5" />
          <span className="text-sm font-medium">{section.label}</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" className="hidden gap-2 text-muted-foreground sm:inline-flex" onClick={openPalette}>
              <Search aria-hidden />
              Перейти
              <Kbd>⌘K</Kbd>
            </Button>
            <HealthIndicator />
            <ThemeMenu />
          </div>
        </header>
        <DatabaseBanner />
        <div className="mx-auto w-full max-w-[1400px] min-w-0 flex-1 px-4 py-6 sm:px-6">{children}</div>
      </SidebarInset>
      {paletteLoaded && (
        <Suspense fallback={null}>
          <CommandPalette open={palette} onOpenChange={setPalette} />
        </Suspense>
      )}
    </SidebarProvider>
  );
}

/** Page title row: the one place that names the page, with its main actions on the right. */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
