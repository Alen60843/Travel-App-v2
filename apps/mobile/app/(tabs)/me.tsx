import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/Card';
import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { apiUrlConfig } from '@/config/env';
import { colors, spacing } from '@/theme/tokens';

/** Placeholder profile plus a developer-facing API configuration check. */
export default function MeScreen() {
  return (
    <Screen title="Me" subtitle="Profile and settings">
      <Card>
        <AppText variant="title">Your profile</AppText>
        <AppText muted>Sign-in and your traveller profile arrive in the next step.</AppText>
      </Card>
      <Card>
        <AppText variant="title">Developer</AppText>
        <View style={styles.row}>
          <View style={[styles.status, { backgroundColor: apiUrlConfig.ok ? colors.confirmed : colors.danger }]} />
          <AppText variant="caption">{apiUrlConfig.ok ? 'API URL configured' : 'API URL missing'}</AppText>
        </View>
        <AppText variant="caption" muted selectable>
          {apiUrlConfig.ok ? apiUrlConfig.baseUrl : apiUrlConfig.issue}
        </AppText>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  status: { width: 8, height: 8, borderRadius: 4 },
});
