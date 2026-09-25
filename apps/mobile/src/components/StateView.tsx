import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { colors, radius, spacing } from '../theme/tokens';
import { AppText } from './AppText';

/** Loading / error / empty building blocks shared by every data screen (7.3+). */
export function LoadingState({ label = 'Loading…' }: { readonly label?: string }) {
  return (
    <View style={styles.container} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.primary} />
      <AppText muted>{label}</AppText>
    </View>
  );
}

export function EmptyState({ title, message }: { readonly title: string; readonly message?: string }) {
  return (
    <View style={styles.container}>
      <AppText variant="title">{title}</AppText>
      {message ? <AppText muted style={styles.center}>{message}</AppText> : null}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <View style={styles.container} accessibilityRole="alert">
      <AppText variant="title">Something went wrong</AppText>
      <AppText muted style={styles.center}>{message}</AppText>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={styles.button}>
          <AppText style={styles.buttonText}>Try again</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
  center: { textAlign: 'center' },
  button: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  buttonText: { color: colors.primaryText, fontWeight: '600' },
});
