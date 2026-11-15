import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import './styles.css';
import { AppShell } from './components/AppShell.tsx';
import { HomePage } from './routes/Home.tsx';
import { InboxPage } from './routes/Inbox.tsx';
import { LibraryPage } from './routes/LibraryPage.tsx';
import { ItemPage } from './routes/ItemPage.tsx';
import { ProjectsPage } from './routes/Projects.tsx';
import { CollectionsPage, CollectionPage } from './routes/Collections.tsx';
import { SearchPage } from './routes/SearchPage.tsx';
import { GraphPage } from './routes/GraphPage.tsx';
import { ChatPage } from './routes/Chat.tsx';
import { SettingsPage } from './routes/Settings.tsx';

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: () => <p className="font-serif text-[18px]">Nothing in this drawer.</p> });
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const parent = () => rootRoute;

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: parent, path: '/', component: HomePage }),
  createRoute({ getParentRoute: parent, path: '/inbox', component: InboxPage }),
  createRoute({
    getParentRoute: parent,
    path: '/library',
    component: LibraryPage,
    validateSearch: (s: Record<string, unknown>) => ({ type: str(s.type), tag: str(s.tag), collection: str(s.collection), view: str(s.view), sort: str(s.sort) }),
  }),
  createRoute({ getParentRoute: parent, path: '/item/$id', component: ItemPage, validateSearch: (s: Record<string, unknown>) => ({ edit: s.edit ? 1 : undefined }) }),
  createRoute({ getParentRoute: parent, path: '/projects', component: ProjectsPage }),
  createRoute({ getParentRoute: parent, path: '/collections', component: CollectionsPage }),
  createRoute({ getParentRoute: parent, path: '/collections/$name', component: CollectionPage }),
  createRoute({ getParentRoute: parent, path: '/search', component: SearchPage, validateSearch: (s: Record<string, unknown>) => ({ q: str(s.q), type: str(s.type) }) }),
  createRoute({
    getParentRoute: parent,
    path: '/graph',
    component: GraphPage,
    validateSearch: (s: Record<string, unknown>) => ({ focus: str(s.focus), depth: s.depth ? Number(s.depth) : undefined }),
  }),
  createRoute({ getParentRoute: parent, path: '/chat', component: ChatPage, validateSearch: (s: Record<string, unknown>) => ({ id: str(s.id) }) }),
  createRoute({ getParentRoute: parent, path: '/settings', component: SettingsPage }),
]);

const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
