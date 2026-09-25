import { Card } from '@/components/Card';
import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';
import { DISCOVERABLE_EVENT_STATUSES } from '@/domain/discoverable-statuses';

export default function ExploreScreen() {
  return (
    <Screen title="Explore" subtitle="Groups forming near you">
      <Card>
        <AppText variant="title">Groups forming near you</AppText>
        <AppText muted>
          Upcoming events and provider sessions you can join will appear here, with how many travellers
          have joined and how many more each group needs.
        </AppText>
        <AppText variant="caption" muted>
          Shows {DISCOVERABLE_EVENT_STATUSES.join(' and ')} events that have not started yet.
        </AppText>
      </Card>
      <EmptyState title="Nothing to show yet" message="Discovery is connected to the TripWith API in a later step." />
    </Screen>
  );
}
