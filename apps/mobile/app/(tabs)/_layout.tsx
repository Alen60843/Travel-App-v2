import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme/tokens';

/** Dependency-free tab indicator; real icons come with the visual pass. */
function TabDot({ focused }: { readonly focused: boolean }) {
  return <View style={[styles.dot, focused && styles.dotFocused]} />;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarIcon: ({ focused }) => <TabDot focused={focused} />,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Explore' }} />
      <Tabs.Screen name="travellers" options={{ title: 'Travellers' }} />
      <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="me" options={{ title: 'Me' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'transparent', marginTop: 6 },
  dotFocused: { backgroundColor: colors.primary },
});
