import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';

export default function TravellersScreen() {
  return (
    <Screen title="Travellers" subtitle="People on overlapping trips">
      <EmptyState title="Coming soon" message="Travellers you match with will appear here." />
    </Screen>
  );
}
