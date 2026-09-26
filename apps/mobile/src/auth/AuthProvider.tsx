import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import type { AuthSession, AuthState } from './auth-session';

interface AuthContextValue {
  readonly state: AuthState;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ session, children }: { readonly session: AuthSession; readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const state = useSyncExternalStore(session.subscribe, session.getState);

  const signOut = useCallback(async () => {
    await session.signOut();
    // Never let one account's cached API data be shown to the next.
    queryClient.clear();
  }, [session, queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, signIn: (email, password) => session.signIn(email, password), signOut }),
    [state, session, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
