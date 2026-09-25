/**
 * TripWith prototype design tokens. Deliberately small: enough for a
 * coherent product shell, not a design system.
 */
export const colors = {
  background: '#F6F4EF',
  surface: '#FFFFFF',
  surfaceMuted: '#EFEBE3',
  border: '#E2DDD2',
  text: '#1C1B19',
  textMuted: '#6B665C',
  primary: '#1F6F5C',
  primaryText: '#FFFFFF',
  accent: '#E07A3F',
  danger: '#B3261E',
  // Group-formation states, reserved for the Explore cards (7.3+).
  forming: '#E07A3F',
  confirmed: '#1F6F5C',
  full: '#6B665C',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: '700' },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
} as const;
