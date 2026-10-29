import { BookMarked, ClipboardCheck, Flame, Gauge, Monitor, MousePointerClick, ScrollText, Workflow } from "lucide-react";

/** Sections of the panel, in sidebar order; frozen ones sit at the bottom of the sidebar (ADR-0031). */
export const NAV = [
  { to: "/", label: "Обзор", icon: Gauge },
  { to: "/agents", label: "Агенты", icon: Monitor },
  { to: "/runs", label: "Конвейер", icon: Workflow },
  { to: "/ls-clicker", label: "LS Clicker", icon: MousePointerClick },
  { to: "/review", label: "Недоработки", icon: ClipboardCheck },
  { to: "/audit", label: "Все логи", icon: ScrollText },
  { to: "/recipes", label: "Рецепты", icon: BookMarked, frozen: true },
  { to: "/farming", label: "Прогрев", icon: Flame, frozen: true },
] as const;

export const sectionOf = (pathname: string) => NAV.find((n) => (n.to === "/" ? pathname === "/" : pathname.startsWith(n.to))) ?? NAV[0];
