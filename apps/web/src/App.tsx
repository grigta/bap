import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { HttpError, api } from "./api.ts";

// Polling every 2 s with a 1.5 s timeout keeps the indicator within the 5 s budget.
const HEALTH_POLL_MS = 2000;

function HealthIndicator() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ status: string }>("/health", { timeoutMs: 1500 }),
    refetchInterval: HEALTH_POLL_MS,
    refetchIntervalInBackground: true,
  });
  const online = health.isSuccess && !health.isError;
  return (
    <span className={`health ${online ? "online" : "offline"}`} data-testid="health" role="status">
      Control Plane: {online ? "online" : "offline"}
    </span>
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

const SECTIONS = ["Agents", "Profiles", "Runs"] as const;

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
        <p className="empty">Пока пусто.</p>
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
      {me.data ? <Shell login={me.data.login} /> : unauthorized ? <LoginForm /> : null}
    </div>
  );
}
