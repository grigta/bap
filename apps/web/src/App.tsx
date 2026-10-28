import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Agents } from "./Agents.tsx";
import { Audit } from "./Audit.tsx";
import { Profiles } from "./Profiles.tsx";
import { Review } from "./Review.tsx";
import { Runs } from "./Runs.tsx";
import { HttpError, api } from "./api.ts";

// Polling every 2 s with a 1.5 s timeout keeps the indicator within the 5 s budget.
const HEALTH_POLL_MS = 2000;

type Health = { status: "ok" | "degraded"; database: "up" | "down" };

/** null while the Control Plane does not answer; a 503 still carries the health body. */
async function fetchHealth(): Promise<Health> {
  try {
    return await api<Health>("/health", { timeoutMs: 1500 });
  } catch (e) {
    if (e instanceof HttpError && e.status === 503) return { status: "degraded", database: "down" };
    throw e;
  }
}

function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: HEALTH_POLL_MS, refetchIntervalInBackground: true });
}

function HealthIndicator() {
  const health = useHealth();
  const online = health.isSuccess && !health.isError;
  return (
    <span className={`health ${online ? "online" : "offline"}`} data-testid="health" role="status">
      Control Plane: {online ? "online" : "offline"}
    </span>
  );
}

function DatabaseBanner() {
  const health = useHealth();
  if (health.data?.database !== "down" || health.isError) return null;
  return (
    <div className="banner" role="alert" data-testid="database-banner">
      База данных недоступна: изменения не сохраняются, данные на экране могут быть устаревшими. Панель обновится, когда база вернётся.
    </div>
  );
}

function LoginForm() {
  const queryClient = useQueryClient();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const submit = useMutation({
    mutationFn: () => api("/auth/login", { method: "POST", body: JSON.stringify({ login, password }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };
  return (
    <form className="login" onSubmit={onSubmit}>
      <h1>Вход</h1>
      <label>
        Логин
        <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" />
      </label>
      <label>
        Пароль
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      <button type="submit" disabled={submit.isPending}>
        Войти
      </button>
      {submit.isError && <p role="alert">Неверный логин или пароль</p>}
    </form>
  );
}

const SECTIONS = ["Agents", "Profiles", "Runs", "Review", "Audit"] as const;

function Shell({ login }: { login: string }) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<(typeof SECTIONS)[number]>("Agents");
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    // reset, not invalidate: a refetch error keeps the previous data and the shell would stay
    onSuccess: () => queryClient.resetQueries({ queryKey: ["me"] }),
  });
  return (
    <>
      <nav>
        {SECTIONS.map((s) => (
          <button key={s} className={s === section ? "active" : ""} onClick={() => setSection(s)}>
            {s}
          </button>
        ))}
        <span className="spacer" />
        <span>{login}</span>
        <button onClick={() => logout.mutate()}>Выйти</button>
      </nav>
      <main>
        <h1>{section}</h1>
        {section === "Agents" ? <Agents /> : section === "Profiles" ? <Profiles /> : section === "Runs" ? <Runs /> : section === "Review" ? <Review /> : <Audit />}
      </main>
    </>
  );
}

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ login: string }>("/auth/me") });
  const unauthorized = me.error instanceof HttpError && me.error.status === 401;
  return (
    <div className="app">
      <header>
        <strong>BAP</strong>
        <HealthIndicator />
      </header>
      <DatabaseBanner />
      {me.data ? <Shell login={me.data.login} /> : unauthorized ? <LoginForm /> : null}
    </div>
  );
}
