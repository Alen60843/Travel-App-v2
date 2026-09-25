import { StyleSheet, Text, type TextProps } from 'react-native';

import { colors, typography } from '../theme/tokens';

export type TextVariant = 'display' | 'title' | 'body' | 'caption';

export interface AppTextProps extends TextProps {
  readonly variant?: TextVariant;
  readonly muted?: boolean;
}

/** The one text primitive: typography comes from tokens, never ad hoc font sizes. */
export function AppText({ variant = 'body', muted = false, style, ...rest }: AppTextProps) {
  return <Text style={[styles[variant], muted && styles.muted, style]} {...rest} />;
}

const styles = StyleSheet.create({
  display: { ...typography.display, color: colors.text },
  title: { ...typography.title, color: colors.text },
  body: { ...typography.body, color: colors.text },
  caption: { ...typography.caption, color: colors.text },
  muted: { color: colors.textMuted },
});
