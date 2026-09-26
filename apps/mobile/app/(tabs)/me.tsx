import { useQuery } from '@tanstack/react-query';
import { Pressable, StyleSheet, View } from 'react-native';

import { presentApiError } from '@/api/error-message';
import { fetchMe, meQueryKey } from '@/api/me';
import { tripwithApi } from '@/api/tripwith-api';
import { AppText } from '@/components/AppText';
import { Card } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { ErrorState, LoadingState } from '@/components/StateView';
import { useAuth } from '@/auth/AuthProvider';
import { apiUrlConfig } from '@/config/env';
import { colors, radius, spacing } from '@/theme/tokens';

/**
 * 7.2.1 end-to-end proof: GET /v1/me through the shared API client, which
 * attaches the Firebase ID token. TripWithAuthGuard verifies it and resolves
 * the internal TripWith user; this screen shows the result (or the API's own
 * error, e.g. AUTH_ACCOUNT_NOT_PROVISIONED) — never a fake fallback.
 */
export default function MeScreen() {
  const { state, signOut } = useAuth();
  const me = useQuery({ queryKey: meQueryKey, queryFn: ({ signal }) => fetchMe(tripwithApi, signal) });
  const firebaseEmail = state.status === 'signed_in' ? state.user.email : null;

  return (
    <Screen title="Me" subtitle={firebaseEmail ?? undefined}>
      {me.isPending ? <LoadingState label="Connecting to TripWith…" /> : null}

      {me.isSuccess ? (
        <Card>
          <View style={styles.row}>
            <View style={[styles.status, { backgroundColor: colors.confirmed }]} />
            <AppText variant="caption">Connected to TripWith API</AppText>
          </View>
          <AppText variant="title">{me.data.profile.displayName}</AppText>
          <AppText muted>{me.data.email}</AppText>
          <AppText variant="caption" muted>
            Account {me.data.accountStatus.toLowerCase()}
            {me.data.onboarding.complete ? ' · profile complete' : ' · profile incomplete'}
          </AppText>
        </Card>
      ) : null}

      {me.isError ? <MeError error={me.error} onRetry={() => void me.refetch()} /> : null}

      <Pressable accessibilityRole="button" onPress={() => void signOut()} style={styles.signOut}>
        <AppText style={styles.signOutText}>Sign out</AppText>
      </Pressable>

      <Card>
        <AppText variant="title">Developer</AppText>
        <AppText variant="caption" muted selectable>
          {apiUrlConfig.ok ? `API ${apiUrlConfig.baseUrl}` : apiUrlConfig.issue}
        </AppText>
      </Card>
    </Screen>
  );
}

function MeError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const presentation = presentApiError(error);
  return (
    <Card>
      <ErrorState message={`${presentation.title}. ${presentation.message}`} onRetry={onRetry} />
      {presentation.reference ? (
        <AppText variant="caption" muted selectable>
          Reference {presentation.reference}
        </AppText>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  status: { width: 8, height: 8, borderRadius: 4 },
  signOut: {
    alignSelf: 'flex-start',
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  signOutText: { color: colors.danger, fontWeight: '600' },
});
