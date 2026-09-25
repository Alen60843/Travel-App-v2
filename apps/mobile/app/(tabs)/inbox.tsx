import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';

export default function InboxScreen() {
  return (
    <Screen title="Inbox" subtitle="Your group and match chats">
      <EmptyState
        title="No conversations yet"
        message="Group chats for events you join and your matches will appear here."
      />
    </Screen>
  );
}
