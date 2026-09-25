import { useLocalSearchParams } from 'expo-router';

import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';

/** Reserved route for GET /v1/events/:eventId (wired in a later step). */
export default function EventDetailScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  return (
    <Screen title="Event" edges={['left', 'right', 'bottom']}>
      <EmptyState title="Event details coming soon" message={`Event ${eventId ?? ''}`.trim()} />
    </Screen>
  );
}
