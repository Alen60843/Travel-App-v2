import { randomUUID } from 'node:crypto';

import { ChatBroadcastService } from './chat-broadcast.service';
import type { RealtimeGateway } from '../realtime';

describe('ChatBroadcastService', () => {
  function makeGateway(emit: jest.Mock) {
    const to = jest.fn().mockReturnValue({ emit });
    return { server: { to } } as unknown as RealtimeGateway;
  }

  it('emits chat:message to userRoom(id) for every supplied member id', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const gateway = { server: { to } } as unknown as RealtimeGateway;
    const service = new ChatBroadcastService(gateway);

    const memberA = randomUUID();
    const memberB = randomUUID();
    const payload = { id: randomUUID(), body: 'hi' };

    service.emitToUsers([memberA, memberB], payload);

    expect(to).toHaveBeenCalledWith(`user:${memberA}`);
    expect(to).toHaveBeenCalledWith(`user:${memberB}`);
    expect(to).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('chat:message', payload);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('emits to no one when given an empty member list', () => {
    const emit = jest.fn();
    const gateway = makeGateway(emit);
    const service = new ChatBroadcastService(gateway);

    service.emitToUsers([], { id: randomUUID() });

    expect(emit).not.toHaveBeenCalled();
  });

  it('does not throw when the underlying emit fails, and still attempts every remaining target', () => {
    const emit = jest.fn();
    const to = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('socket.io adapter unavailable');
      })
      .mockReturnValue({ emit });
    const gateway = { server: { to } } as unknown as RealtimeGateway;
    const service = new ChatBroadcastService(gateway);

    const failingMember = randomUUID();
    const okMember = randomUUID();

    expect(() =>
      service.emitToUsers([failingMember, okMember], { id: randomUUID() }),
    ).not.toThrow();
    expect(to).toHaveBeenCalledWith(`user:${failingMember}`);
    expect(to).toHaveBeenCalledWith(`user:${okMember}`);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
