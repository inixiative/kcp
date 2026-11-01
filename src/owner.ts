import { z } from 'zod';
import type { OwnerSelector } from './selectors';

type OwnerIds = {
  ownerModel: string;
  userId?: string | null;
  organizationId?: string | null;
  spaceId?: string | null;
};

/** Kingdom's canonical owner key: `ownerModel:userId:organizationId:spaceId`, absent ids empty. */
export const ownerKey = (owner: OwnerIds) =>
  [owner.ownerModel, owner.userId ?? '', owner.organizationId ?? '', owner.spaceId ?? ''].join(':');

const uuidOrEmpty =
  '(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?';
export const ownerKeySchema = z
  .string()
  .regex(
    new RegExp(`^(?:User|OrganizationUser|Organization|Space|SpaceUser)(?::${uuidOrEmpty}){3}$`),
  );

/** Whether an owner is the one a selector names: same model, and every id the selector gives. */
export const ownerMatches = (selector: OwnerSelector, owner: OwnerIds) =>
  selector.ownerModel === owner.ownerModel &&
  (selector.userId === undefined || selector.userId === owner.userId) &&
  (selector.organizationId === undefined || selector.organizationId === owner.organizationId) &&
  (selector.spaceId === undefined || selector.spaceId === owner.spaceId);
