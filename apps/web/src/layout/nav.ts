import { BookMarked, ClipboardCheck, Flame, Gauge, Monitor, PlayCircle, ScrollText, UserRound } from "lucide-react";

/** Sections of the panel, in sidebar order. */
export const NAV = [
  { to: "/", label: "Обзор", icon: Gauge },
  { to: "/agents", label: "Агенты", icon: Monitor },
  { to: "/profiles", label: "Профили", icon: UserRound },
  { to: "/runs", label: "Задания", icon: PlayCircle },
  { to: "/recipes", label: "Рецепты", icon: BookMarked },
  { to: "/farming", label: "Прогрев", icon: Flame },
  { to: "/review", label: "Проверка", icon: ClipboardCheck },
  { to: "/audit", label: "Аудит", icon: ScrollText },
] as const;

export const sectionOf = (pathname: string) => NAV.find((n) => (n.to === "/" ? pathname === "/" : pathname.startsWith(n.to))) ?? NAV[0];
