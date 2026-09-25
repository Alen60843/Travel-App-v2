import { Link, Stack } from 'expo-router';

import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Screen title="Page not found">
        <Link href="/">
          <AppText>Back to Explore</AppText>
        </Link>
      </Screen>
    </>
  );
}
