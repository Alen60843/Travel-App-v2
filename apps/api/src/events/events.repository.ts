import { Injectable } from '@nestjs/common';
import type { DeepPartial, EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';

import { EventCategoryEntity, EventEntity } from '../database/entities';
import { EVENT_MANAGED_BY_USER_SQL } from './event-management';

@Injectable()
export class EventsRepository {
  constructor(private readonly dataSource: DataSource) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }

  /** Every Event the user manages (see event-management.ts): own USER-hosted Events and owned Provider sessions. */
  findOwnedEvents(userId: string): Promise<EventEntity[]> {
    return this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .innerJoinAndSelect('event.category', 'category')
      .where(EVENT_MANAGED_BY_USER_SQL, { userId })
      .orderBy('event.created_at', 'DESC')
      .addOrderBy('event.id', 'ASC')
      .getMany();
  }

  findOwnedEvent(
    manager: EntityManager,
    userId: string,
    eventId: string,
    lock = false,
  ): Promise<EventEntity | null> {
    const query = manager
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .innerJoinAndSelect('event.category', 'category')
      .where(`event.id = :eventId AND ${EVENT_MANAGED_BY_USER_SQL}`, { eventId, userId });
    if (lock) query.setLock('pessimistic_write', undefined, ['event']);
    return query.getOne();
  }

  findOwnedEventView(userId: string, eventId: string): Promise<EventEntity | null> {
    return this.findOwnedEvent(this.dataSource.manager, userId, eventId);
  }

  findCategory(
    manager: EntityManager,
    categoryId: number,
    lock = false,
  ): Promise<EventCategoryEntity | null> {
    const query = manager
      .getRepository(EventCategoryEntity)
      .createQueryBuilder('category')
      .where('category.id = :categoryId', { categoryId });
    if (lock) query.setLock('pessimistic_read');
    return query.getOne();
  }

  createEvent(manager: EntityManager, values: DeepPartial<EventEntity>): EventEntity {
    return manager.getRepository(EventEntity).create(values);
  }

  async saveEvent(manager: EntityManager, event: EventEntity): Promise<EventEntity> {
    const saved = await manager.getRepository(EventEntity).save(event);
    // Re-read instead of relying on TypeORM's partial RETURNING projection:
    // participant_count and time_range are database-owned, and category is
    // required by the management serializer.
    const reloaded = await manager
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .innerJoinAndSelect('event.category', 'category')
      .where('event.id = :eventId', { eventId: saved.id })
      .getOne();
    if (!reloaded) throw new Error('Saved Event could not be re-read.');
    return reloaded;
  }

  async setTransitionContext(
    manager: EntityManager,
    actorUserId: string,
    // 'seat_freed' (WS8.4B): a FULL -> ACTIVE bounce-back when a leave/remove
    // frees a seat. Describes only why the EVENT status changed — whether
    // the freed seat came from a voluntary leave or a host removal is a
    // separate fact recorded on the EventParticipant row itself
    // (event_participants.cancellation_reason), not overloaded onto this.
    reason: 'host_publish' | 'host_cancel' | 'capacity_reached' | 'seat_freed',
  ): Promise<void> {
    await manager.query(
      `SELECT set_config('tripwith.actor_user_id', $1, true),
              set_config('tripwith.transition_reason', $2, true)`,
      [actorUserId, reason],
    );
  }
}
