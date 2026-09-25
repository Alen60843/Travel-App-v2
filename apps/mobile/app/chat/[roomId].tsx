import { useLocalSearchParams } from 'expo-router';

import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';

/** Reserved route for the chat room (GET /v1/chat/rooms/:roomId + messages), wired later. */
export default function ChatRoomScreen() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  return (
    <Screen title="Chat" edges={['left', 'right', 'bottom']}>
      <EmptyState title="Chat coming soon" message={`Room ${roomId ?? ''}`.trim()} />
    </Screen>
  );
}
