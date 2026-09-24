export interface ReviewView {
  readonly id: string;
  readonly reviewerUserId: string;
  readonly reviewerType: string;
  readonly reviewerProviderId: string | null;
  readonly targetType: string;
  readonly targetUserId: string | null;
  readonly targetProviderId: string | null;
  readonly eventId: string | null;
  readonly rating: number;
  readonly body: string | null;
  readonly signals: Record<string, boolean>;
  readonly isVerified: boolean;
  readonly moderationState: string;
  readonly createdAt: string;
}
