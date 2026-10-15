import { featureRoutes } from './features/registry';
import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTheme, MantineProvider, type MantineColorsTuple } from '@mantine/core';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { onApiErrorCode, onUnauthorized } from './lib/api';
import { MFA_ENROLLMENT_REQUIRED, REAUTH_REQUIRED } from '@oriel/shared';
import { queryClient } from './lib/queryClient';
import { qk } from './lib/queryKeys';
import { clearClientState } from './lib/session';
import { useTheme } from './lib/theme';
import { initContrast } from './shell/nav/contrast';
import './shell/nav/contrast.css';
import { registerAppNavigate } from './lib/util';
import { ConfirmHost, PromptHost, Toaster } from './components/Overlays';
import { ContextMenuHost } from './components/ContextMenu';
import { LoginPage, SignupPage } from './auth/AuthPages';
import { InvitePage } from './auth/InvitePage';
import { ForgotPasswordPage, ResetPasswordPage } from './auth/PasswordPages';
import { EnrollPage } from './auth/EnrollPage';
import { ReauthHost, requestReauth } from './auth/ReauthDialog';
import { RootRedirect } from './pages/RootRedirect';
import { AppShell } from './shell/AppShell';
import { HomePage } from './pages/HomePage';
import { PageRoute } from './pages/PageRoute';
import { TrashPage } from './pages/TrashPage';
import { SettingsPage } from './pages/SettingsPage';
import { PublicPage } from './pages/PublicPage';
import { PublicFormPage } from './database';
import { NotFoundPage } from './pages/NotFoundPage';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  { path: '/invite/:token', element: <InvitePage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password/:token', element: <ResetPasswordPage /> },
  { path: '/security/enroll', element: <EnrollPage /> },
  { path: '/share/:pageId', element: <PublicPage /> },
  { path: '/share/:pageId/form/:viewId', element: <PublicFormPage /> },
  { path: '/', element: <RootRedirect /> },
  {
    path: '/w/:workspaceId',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'p/:pageId', element: <PageRoute /> },
      { path: 'trash', element: <TrashPage /> },
      { path: 'settings/:tab?', element: <SettingsPage /> },
      ...featureRoutes,
      { path: '*', element: <Navigate to=".." replace /> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);

registerAppNavigate((to, opts) => void router.navigate(to, opts));
// Navigation module: high contrast preference (tokens in shell/nav/contrast.css).
initContrast();

const PUBLIC_PREFIXES = ['/login', '/signup', '/invite/', '/share/', '/forgot-password', '/reset-password/'];

// Account security (G9): sensitive actions ask to confirm the identity, then are replayed; a workspace
// requiring two-factor authentication sends non-enrolled accounts to the enrolment page.
onApiErrorCode(REAUTH_REQUIRED, () => requestReauth());
onApiErrorCode(MFA_ENROLLMENT_REQUIRED, async () => {
  if (window.location.pathname !== '/security/enroll') void router.navigate('/security/enroll', { replace: true });
  return false;
});

onUnauthorized(() => {
  const path = window.location.pathname;
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return;
  clearClientState();
  queryClient.setQueryData(qk.session, null);
  const next = path && path !== '/' ? `?next=${encodeURIComponent(path)}` : '';
  void router.navigate(`/login${next}`, { replace: true });
});

const accent: MantineColorsTuple = [
  '#eaf1fd',
  '#d4e2fb',
  '#a8c4f5',
  '#7aa5ef',
  '#548aea',
  '#3b79e6',
  '#2f6fde',
  '#255ec4',
  '#1d52ac',
  '#114592',
];

const mantineTheme = createTheme({
  primaryColor: 'accent',
  colors: { accent },
  fontFamily: 'var(--font-sans)',
  fontFamilyMonospace: 'var(--font-mono)',
  defaultRadius: 'md',
  cursorType: 'pointer',
});

function ThemedApp() {
  const theme = useTheme();
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme.resolved);
  }, [theme.resolved]);
  return (
    <MantineProvider theme={mantineTheme} forceColorScheme={theme.resolved}>
      <RouterProvider router={router} />
      <Toaster />
      <ContextMenuHost />
      <ConfirmHost />
      <PromptHost />
      <ReauthHost />
    </MantineProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemedApp />
    </QueryClientProvider>
  );
}
