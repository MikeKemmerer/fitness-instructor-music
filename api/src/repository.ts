import type { Role, Routine } from '../../shared/routine';

export interface Membership {
  tenantId: string;
  objectId: string;
  role: Role;
  active: boolean;
}

export interface RoutineHead {
  draft: Routine;
  publications: Map<number, Routine>;
  publishedRevision?: number;
  deleted: boolean;
}

export interface HouseholdState {
  membershipRevision: number;
  members: Map<string, Membership>;
  routines: Map<string, RoutineHead>;
}

export interface HouseholdRepository {
  transact<Result>(householdId: string, operation: (state: HouseholdState) => Result): Promise<Result>;
}

export function memberKey(tenantId: string, objectId: string): string {
  return JSON.stringify([tenantId, objectId]);
}