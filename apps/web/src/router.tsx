import { useQuery } from "@tanstack/react-query";
import { type ErrorComponentProps, Outlet, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { z } from "zod";
import { AppShell } from "@/layout/app-shell";
import { HttpError, api } from "@/lib/api";
import { RUN_STATUSES } from "@/lib/types";
import { LoginPage } from "@/pages/login";

// Each page is its own chunk: charts and tables load with the page that shows them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any props; the page's own props type is kept
const page = <M extends Record<K, React.ComponentType<any>>, K extends keyof M & string>(load: () => Promise<M>, name: K) => lazy(async () => ({ default: (await load())[name] }));
const OverviewPage = page(() => import("@/pages/overview"), "OverviewPage");
const AgentsPage = page(() => import("@/pages/agents"), "AgentsPage");
const RunsPage = page(() => import("@/pages/runs"), "RunsPage");
const PipelinePage = page(() => import("@/pages/pipeline-table"), "PipelinePage");
const ReviewPage = page(() => import("@/pages/review"), "ReviewPage");
const RecipesPage = page(() => import("@/pages/recipes"), "RecipesPage");
const AuditPage = page(() => import("@/pages/audit"), "AuditPage");
const FarmingPage = page(() => import("@/pages/farming"), "FarmingPage");

/** Signed in: the panel; 401: the login form in place, so the URL (a deep link) survives signing in. */
function Root() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ login: string }>("/auth/me") });
  if (me.data)
    return (
      <AppShell login={me.data.login}>
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </AppShell>
    );
  return me.error instanceof HttpError && me.error.status === 401 ? <LoginPage /> : null;
}

const rootRoute = createRootRoute({ component: Root });
const runsSearch = z.object({ status: z.enum(RUN_STATUSES).optional().catch(undefined), tab: z.enum(["runs", "table"]).optional().catch(undefined) });

const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage });
const agentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agents", component: () => <AgentsPage /> });
const agentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agents/$agentId", component: () => <AgentsPage agentId={agentRoute.useParams().agentId} /> });
// The table was a tab of runs; it is «Конвейер» now and runs are a tab of «Все логи».
const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  validateSearch: runsSearch,
  beforeLoad: ({ search }) => {
    if (search.tab === "table") throw redirect({ to: "/pipeline" });
  },
  component: () => <RunsPage status={runsRoute.useSearch().status} />,
});
const pipelineRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pipeline", component: () => <PipelinePage /> });
const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  validateSearch: runsSearch,
  component: () => <RunsPage runId={runRoute.useParams().runId} status={runRoute.useSearch().status} />,
});
const recipesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/recipes", component: () => <RecipesPage /> });
const recipeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recipes/$recipeId",
  validateSearch: z.object({ version: z.string().optional().catch(undefined) }),
  component: () => <RecipesPage recipeId={recipeRoute.useParams().recipeId} version={recipeRoute.useSearch().version} />,
});
const farmingRoute = createRoute({ getParentRoute: () => rootRoute, path: "/farming", component: FarmingPage });
// LS Clicker is part of «Конвейер» now: the old address leads there.
const lsClickerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/ls-clicker", beforeLoad: () => { throw redirect({ to: "/pipeline" }); } });
const reviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/review", component: ReviewPage });
const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  validateSearch: z.object({ denied: z.boolean().optional().catch(undefined) }),
  component: () => <AuditPage denied={!!auditRoute.useSearch().denied} />,
});

const routeTree = rootRoute.addChildren([overviewRoute, agentsRoute, agentRoute, pipelineRoute, runsRoute, runRoute, recipesRoute, recipeRoute, farmingRoute, lsClickerRoute, reviewRoute, auditRoute]);

/** A page that throws shows what failed in place of the page, not a blank panel. */
function PageError({ error, reset }: ErrorComponentProps) {
  return (
    <div role="alert" className="rounded-lg border border-fail/30 bg-fail-soft p-4 text-sm text-fail">
      <p className="font-medium">Страница не отрисовалась: {error instanceof Error ? error.message : String(error)}</p>
      <button type="button" className="mt-2 underline" onClick={reset}>
        Попробовать снова
      </button>
    </div>
  );
}

export const router = createRouter({ routeTree, defaultPreload: "intent", defaultErrorComponent: PageError });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
