import { BookMarked, ClipboardCheck, Flame, Gauge, Monitor, ScrollText, Workflow } from "lucide-react";

/** Sections of the panel, in sidebar order; frozen ones sit at the bottom of the sidebar (ADR-0031). */
export const NAV = [
  { to: "/", label: "Обзор", icon: Gauge },
  { to: "/agents", label: "Агенты", icon: Monitor },
  { to: "/pipeline", label: "Конвейер", icon: Workflow },
  { to: "/review", label: "Недоработки", icon: ClipboardCheck },
  { to: "/audit", label: "Все логи", icon: ScrollText },
  { to: "/recipes", label: "Рецепты", icon: BookMarked, frozen: true },
  { to: "/farming", label: "Прогрев", icon: Flame, frozen: true },
] as const;

// Runs are the second tab of «Все логи».
export const sectionOf = (pathname: string) => NAV.find((n) => (n.to === "/" ? pathname === "/" : pathname.startsWith(n.to) || (n.to === "/audit" && pathname.startsWith("/runs")))) ?? NAV[0];
