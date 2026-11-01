import type { OwnerSelector } from './selectors';

type OwnerIds = {
  ownerModel: string;
  userId?: string | null;
  organizationId?: string | null;
  spaceId?: string | null;
};

/** Whether an owner is the one a selector names: same model, and every id the selector gives. */
export const ownerMatches = (selector: OwnerSelector, owner: OwnerIds) =>
  selector.ownerModel === owner.ownerModel &&
  (selector.userId === undefined || selector.userId === owner.userId) &&
  (selector.organizationId === undefined || selector.organizationId === owner.organizationId) &&
  (selector.spaceId === undefined || selector.spaceId === owner.spaceId);
