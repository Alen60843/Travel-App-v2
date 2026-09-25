import { GUARDS_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { EventHostType, EventStatus, EventVisibility, JoinRequestStatus, UserAccountStatus } from '@tripwith/shared';

import { type AuthenticatedUser, TripWithAuthGuard } from '../auth';
import type { EventEntity } from '../database/entities';
import { EventDetailController } from './event-detail.controller';
import {
  canViewEventDetail,
  deriveViewerRelationship,
  effectiveJoinRequestStatus,
  type EventDetailAccessFacts,
  type EventDetailService,
  type EventViewerFacts,
  toPublicEventDetail,
} from './event-detail.service';
import { EventViewerPrimaryAction } from './event-detail.types';

const NOW = new Date('2090-01-01T00:00:00Z');
const FUTURE = new Date('2090-01-10T06:00:00Z');

const access = (overrides: Partial<EventDetailAccessFacts> = {}): EventDetailAccessFacts => ({
  status: EventStatus.Active,
  visibility: EventVisibility.Public,
  hasManager: true,
  isManager: false,
  isParticipant: false,
  hasLivePendingRequest: false,
  ...overrides,
});

const viewerFacts = (overrides: Partial<EventViewerFacts> = {}): EventViewerFacts => ({
  isManager: false,
  activeParticipantGuestCount: null,
  latestJoinRequest: null,
  event: { status: EventStatus.Active, startsAt: FUTURE, depositMinor: 0, minTrustScore: 2 },
  hasManager: true,
  viewerTrustScore: 5,
  chatRoomId: 'room-1',
  now: NOW,
  ...overrides,
});

const request = (status: JoinRequestStatus, guestCount = 0, expiresAt = FUTURE) => ({
  id: 'request-1', status, guestCount, expiresAt,
});

describe('canViewEventDetail (traveller access policy)', () => {
  it('lets an unrelated traveller view a PUBLIC ACTIVE or FULL Event', () => {
    expect(canViewEventDetail(access())).toBe(true);
    expect(canViewEventDetail(access({ status: EventStatus.Full }))).toBe(true);
  });

  it('never shows a DRAFT to anyone but its manager', () => {
    expect(canViewEventDetail(access({ status: EventStatus.Draft }))).toBe(false);
    expect(canViewEventDetail(access({ status: EventStatus.Draft, isParticipant: true }))).toBe(false);
    expect(canViewEventDetail(access({ status: EventStatus.Draft, hasLivePendingRequest: true }))).toBe(false);
    expect(canViewEventDetail(access({ status: EventStatus.Draft, isManager: true }))).toBe(true);
  });

  it.each([EventVisibility.Unlisted, EventVisibility.Private])(
    'does not leak a %s Event to an unrelated traveller',
    (visibility) => {
      expect(canViewEventDetail(access({ visibility }))).toBe(false);
      expect(canViewEventDetail(access({ visibility, isParticipant: true }))).toBe(true);
      expect(canViewEventDetail(access({ visibility, hasLivePendingRequest: true }))).toBe(true);
      expect(canViewEventDetail(access({ visibility, isManager: true }))).toBe(true);
    },
  );

  it.each([EventStatus.InProgress, EventStatus.Completed, EventStatus.Cancelled])(
    'hides a %s PUBLIC Event from strangers but keeps it for its participants',
    (status) => {
      expect(canViewEventDetail(access({ status }))).toBe(false);
      expect(canViewEventDetail(access({ status, isParticipant: true }))).toBe(true);
    },
  );

  it('hides an unclaimed provider session (no manager) from unrelated travellers', () => {
    expect(canViewEventDetail(access({ hasManager: false }))).toBe(false);
    expect(canViewEventDetail(access({ hasManager: false, isParticipant: true }))).toBe(true);
  });
});

describe('deriveViewerRelationship', () => {
  it('lets an unrelated eligible traveller request to join, with no chat room', () => {
    expect(deriveViewerRelationship(viewerFacts())).toEqual({
      isManager: false,
      isParticipant: false,
      partySize: null,
      joinRequest: null,
      canRequestToJoin: true,
      joinUnavailableReason: null,
      primaryAction: EventViewerPrimaryAction.RequestToJoin,
      chatRoomId: null,
    });
  });

  it('still offers REQUEST_TO_JOIN on a FULL Event (the request may stay PENDING)', () => {
    const view = deriveViewerRelationship(viewerFacts({
      event: { status: EventStatus.Full, startsAt: FUTURE, depositMinor: 0, minTrustScore: 0 },
    }));
    expect(view).toMatchObject({ canRequestToJoin: true, primaryAction: 'REQUEST_TO_JOIN' });
  });

  it('reports an active participant with party size and the chat room', () => {
    expect(deriveViewerRelationship(viewerFacts({
      activeParticipantGuestCount: 1,
      latestJoinRequest: request(JoinRequestStatus.Approved, 1),
    }))).toMatchObject({
      isParticipant: true,
      partySize: 2,
      joinRequest: { id: 'request-1', status: 'APPROVED', requestedSeats: 2 },
      canRequestToJoin: false,
      joinUnavailableReason: null,
      primaryAction: 'OPEN_CHAT',
      chatRoomId: 'room-1',
    });
  });

  it('reports the manager with MANAGE and the chat room', () => {
    expect(deriveViewerRelationship(viewerFacts({ isManager: true }))).toMatchObject({
      isManager: true,
      isParticipant: false,
      canRequestToJoin: false,
      primaryAction: 'MANAGE',
      chatRoomId: 'room-1',
    });
  });

  it('reports a live PENDING request as awaiting approval, without membership or chat', () => {
    expect(deriveViewerRelationship(viewerFacts({
      latestJoinRequest: request(JoinRequestStatus.Pending, 2),
    }))).toMatchObject({
      isParticipant: false,
      joinRequest: { status: 'PENDING', requestedSeats: 3 },
      canRequestToJoin: false,
      primaryAction: 'AWAITING_APPROVAL',
      chatRoomId: null,
    });
  });

  it('treats an overdue PENDING row as EXPIRED and lets the traveller request again', () => {
    const overdue = request(JoinRequestStatus.Pending, 0, new Date('2089-12-31T00:00:00Z'));
    expect(effectiveJoinRequestStatus(overdue, NOW)).toBe(JoinRequestStatus.Expired);
    expect(deriveViewerRelationship(viewerFacts({ latestJoinRequest: overdue }))).toMatchObject({
      joinRequest: { status: 'EXPIRED' },
      canRequestToJoin: true,
      primaryAction: 'REQUEST_TO_JOIN',
    });
  });

  it('never treats a historical APPROVED request without active participation as membership', () => {
    const view = deriveViewerRelationship(viewerFacts({
      activeParticipantGuestCount: null, // participation since cancelled / never active
      latestJoinRequest: request(JoinRequestStatus.Approved, 3),
    }));
    expect(view).toMatchObject({
      isParticipant: false,
      partySize: null,
      joinRequest: { status: 'APPROVED' },
      canRequestToJoin: true,
      primaryAction: 'REQUEST_TO_JOIN',
      chatRoomId: null,
    });
  });

  it.each([
    ['EVENT_TRUST_REQUIRED', { viewerTrustScore: 1 }],
    ['EVENT_TRUST_REQUIRED', { viewerTrustScore: null }],
    ['EVENT_NOT_JOINABLE', { event: { status: EventStatus.Cancelled, startsAt: FUTURE, depositMinor: 0, minTrustScore: 0 } }],
    ['EVENT_NOT_JOINABLE', { event: { status: EventStatus.Active, startsAt: NOW, depositMinor: 0, minTrustScore: 0 } }],
    ['EVENT_NOT_JOINABLE', { hasManager: false }],
    ['PAID_JOIN_NOT_AVAILABLE', { event: { status: EventStatus.Active, startsAt: FUTURE, depositMinor: 500, minTrustScore: 0 } }],
  ] as const)('reports %s instead of offering a join the server would refuse', (reason, overrides) => {
    expect(deriveViewerRelationship(viewerFacts(overrides as Partial<EventViewerFacts>))).toMatchObject({
      canRequestToJoin: false,
      joinUnavailableReason: reason,
      primaryAction: 'NONE',
      chatRoomId: null,
    });
  });
});

describe('toPublicEventDetail', () => {
  const entity = {
    id: 'event-1', hostType: EventHostType.Provider, hostUserId: null, hostProviderId: 'provider-1',
    category: { id: 3, code: 'trek', label: 'Trek', icon: null, isActive: true, sortOrder: 1 },
    categoryId: 3, title: 'Rainbow Mountain', description: null,
    status: EventStatus.Active, visibility: EventVisibility.Public,
    capacityMin: 8, capacityMax: 12, participantCount: 2, hostGuestCount: 0, reservedSeatCount: 7,
    priceMinor: 4500, depositMinor: 0, currency: 'USD',
    startsAt: FUTURE, endsAt: new Date('2090-01-10T16:00:00Z'), timeRange: '[)',
    meetingPoint: { type: 'Point', coordinates: [-71.27, -13.87] }, meetingPointLabel: 'Cusco plaza',
    minTrustScore: 0, joinApprovalRequired: false, cancellationPolicy: null,
    createdAt: NOW, updatedAt: NOW, cancelledAt: null, completedAt: null,
  } as unknown as EventEntity;

  it('serializes FORMING group fields and drops management-only fields', () => {
    const detail = toPublicEventDetail(entity);
    expect(detail).toMatchObject({
      reservedSeatCount: 7, remainingSeats: 5, capacityMin: 8,
      groupState: 'FORMING', seatsToConfirm: 1,
      meetingPoint: { latitude: -13.87, longitude: -71.27, label: 'Cusco plaza' },
    });
    for (const hidden of [
      'hostUserId', 'hostProviderId', 'hostGuestCount', 'depositMinor', 'timeRange',
      'createdAt', 'updatedAt', 'cancelledAt', 'completedAt', 'categoryId',
    ]) {
      expect(detail).not.toHaveProperty(hidden);
    }
  });

  it('serializes CONFIRMED once reserved seats reach the minimum', () => {
    expect(toPublicEventDetail({ ...entity, reservedSeatCount: 9 } as EventEntity)).toMatchObject({
      groupState: 'CONFIRMED', seatsToConfirm: 0, remainingSeats: 3,
    });
  });
});

describe('EventDetailController', () => {
  it('serves GET /v1/events/:eventId behind the Firebase auth guard, for the authenticated viewer only', async () => {
    expect(Reflect.getMetadata(PATH_METADATA, EventDetailController)).toBe('events');
    expect(Reflect.getMetadata(VERSION_METADATA, EventDetailController)).toBe('1');
    expect(Reflect.getMetadata(GUARDS_METADATA, EventDetailController)).toEqual([TripWithAuthGuard]);
    expect(Reflect.getMetadata(PATH_METADATA, EventDetailController.prototype.getEventDetail)).toBe(':eventId');

    const service = { getEventDetail: jest.fn().mockResolvedValue({}) };
    const controller = new EventDetailController(service as unknown as EventDetailService);
    const viewer = {
      id: 'viewer-internal-id', firebaseUid: 'firebase-viewer', accountStatus: UserAccountStatus.Active,
    } as AuthenticatedUser;
    await controller.getEventDetail(viewer, 'event-1');
    expect(service.getEventDetail).toHaveBeenCalledWith('viewer-internal-id', 'event-1');
  });
});
