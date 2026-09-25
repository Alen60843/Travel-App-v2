import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createQueryClient } from '@/api/query-client';
import { colors } from '@/theme/tokens';

/**
 * App root: providers + a stack whose first screen is the tab shell. Event
 * Detail and Chat Room are pushed on top of the tabs (routes reserved now,
 * wired to the API in later steps). 7.2 adds the auth gate here.
 */
export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerTintColor: colors.primary,
            headerStyle: { backgroundColor: colors.background },
            contentStyle: { backgroundColor: colors.background },
            headerBackButtonDisplayMode: 'minimal',
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="events/[eventId]" options={{ title: 'Event' }} />
          <Stack.Screen name="chat/[roomId]" options={{ title: 'Chat' }} />
        </Stack>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
