import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme/tokens';
import { AppText } from './AppText';

export interface ScreenProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children?: ReactNode;
  /** Tab screens sit above the tab bar, so they skip the bottom inset. */
  readonly edges?: readonly Edge[];
}

/** Safe-area aware, scrollable page with a consistent header. */
export function Screen({ title, subtitle, children, edges = ['top', 'left', 'right'] }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safeArea} edges={edges}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <AppText variant="display" accessibilityRole="header">{title}</AppText>
          {subtitle ? <AppText muted>{subtitle}</AppText> : null}
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg },
  header: { gap: spacing.xs, paddingTop: spacing.sm },
});
