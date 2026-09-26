import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { createQueryClient } from '@/api/query-client';
import { AppText } from '@/components/AppText';
import { Card } from '@/components/Card';
import { LoadingState } from '@/components/StateView';
import { resolveAuthRoute } from '@/auth/auth-session';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { authSession } from '@/auth/session';
import { colors, spacing } from '@/theme/tokens';

/**
 * App root: providers, then the auth gate. Only a Firebase-signed-in user can
 * reach the tab shell and the Event/Chat routes; signed-out users only see
 * Login. Missing Firebase config blocks the app entirely (no bypass).
 */
export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider session={authSession}>
          <StatusBar style="dark" />
          <AuthGate />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function AuthGate() {
  const { state } = useAuth();
  const route = resolveAuthRoute(state);

  if (route === 'loading') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <LoadingState label="Starting TripWith…" />
      </SafeAreaView>
    );
  }
  if (route === 'config-error' && state.status === 'unavailable') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg }}>
        <Card>
          <AppText variant="title">Sign-in is not configured</AppText>
          <AppText muted selectable>{state.issue}</AppText>
        </Card>
      </SafeAreaView>
    );
  }

  const signedIn = route === 'app';
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.primary,
        headerStyle: { backgroundColor: colors.background },
        contentStyle: { backgroundColor: colors.background },
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="events/[eventId]" options={{ title: 'Event' }} />
        <Stack.Screen name="chat/[roomId]" options={{ title: 'Chat' }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}
