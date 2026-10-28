import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { api } from "@/lib/api";
import { shortId } from "@/lib/format";
import type { Agent, Profile, Run } from "@/lib/types";
import { NAV } from "./nav";

/** Cmd+K / Ctrl+K: jump to a section, a run by its id, an agent or a profile by name. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<Agent[]>("/agents"), enabled: open });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/profiles"), enabled: open });
  const runs = useQuery({ queryKey: ["runs", ""], queryFn: () => api<Run[]>("/runs"), enabled: open });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const go = (to: string, params?: Record<string, string>) => {
    onOpenChange(false);
    void navigate({ to, params } as never);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Быстрый переход" description="Раздел, задание, агент или профиль">
      <Command>
      <CommandInput placeholder="Раздел, id задания, агент, профиль…" />
      <CommandList>
        <CommandEmpty>Ничего не найдено.</CommandEmpty>
        <CommandGroup heading="Разделы">
          {NAV.map((n) => (
            <CommandItem key={n.to} value={`раздел ${n.label}`} onSelect={() => go(n.to)}>
              <n.icon aria-hidden />
              {n.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {!!runs.data?.length && (
          <CommandGroup heading="Задания">
            {runs.data.slice(0, 50).map((r) => (
              <CommandItem key={r.id} value={`задание ${r.id} ${r.scenarioId} ${r.status}`} onSelect={() => go("/runs/$runId", { runId: r.id })}>
                <span className="font-mono text-xs">{shortId(r.id)}</span>
                <span>{r.scenarioId}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{r.status}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!!agents.data?.length && (
          <CommandGroup heading="Агенты">
            {agents.data.map((a) => (
              <CommandItem key={a.id} value={`агент ${a.name}`} onSelect={() => go("/agents/$agentId", { agentId: a.id })}>
                {a.name}
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{a.connection}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!!profiles.data?.length && (
          <CommandGroup heading="Профили">
            {profiles.data.map((p) => (
              <CommandItem key={p.id} value={`профиль ${p.name} ${p.agentName}`} onSelect={() => go("/profiles")}>
                {p.name}
                <span className="text-muted-foreground">на {p.agentName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
