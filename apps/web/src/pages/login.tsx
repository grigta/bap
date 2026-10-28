import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Monitor } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { HealthIndicator } from "@/layout/health";
import { api } from "@/lib/api";

export function LoginPage() {
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
    <div className="grid min-h-svh place-items-center bg-sidebar px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-between">
          <span className="flex items-center gap-2.5 text-sm font-semibold">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
              <Monitor className="size-4" aria-hidden />
            </span>
            BAP
          </span>
          <HealthIndicator />
        </div>
        <form onSubmit={onSubmit} className="rounded-lg border bg-card p-6 shadow-xs">
          <h1 className="text-lg font-semibold tracking-tight">Вход</h1>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">Панель оператора парка Mac с Linken Sphere.</p>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="login">Логин</FieldLabel>
              <Input id="login" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Пароль</FieldLabel>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
            {submit.isError && (
              <Alert variant="destructive">
                <AlertDescription>Неверный логин или пароль</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={submit.isPending} className="w-full">
              Войти
            </Button>
          </FieldGroup>
        </form>
      </div>
    </div>
  );
}
