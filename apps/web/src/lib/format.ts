import { useEffect, useState } from "react";

/** Re-renders every second, for "N с назад" labels. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return "никогда";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  return `${Math.floor(s / 3600)} ч назад`;
}

export const seconds = (fromIso: string, toIso: string) => `${((Date.parse(toIso) - Date.parse(fromIso)) / 1000).toFixed(1)} с`;
export const time = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU");
export const dateTime = (iso: string) => new Date(iso).toLocaleString("ru-RU");
export const shortId = (id: string) => id.slice(0, 8);
