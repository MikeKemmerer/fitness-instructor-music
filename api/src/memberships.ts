import { Authorization, type AuthorizationPolicy, type VerifiedPrincipal } from './auth';
import { ServiceError } from './errors';
import { memberKey, type HouseholdRepository, type HouseholdState, type Membership } from './repository';
import { boolean, choice, expectedRevision, strictRecord, text } from './validation';

export interface MembershipList {
  revision: number;
  members: Membership[];
}

export class MembershipService {
  readonly #authorization: Authorization;
  readonly #tenantId: string;

  constructor(readonly repository: HouseholdRepository, policy: AuthorizationPolicy) {
    this.#authorization = new Authorization(policy);
    this.#tenantId = text(policy.tenantId);
  }

  async #run<Result>(principal: VerifiedPrincipal | null | undefined, householdId: string,
    operation: (state: HouseholdState) => Result): Promise<Result> {
    const identity = this.#authorization.identity(principal);
    return this.repository.transact(text(householdId), state => {
      this.#authorization.member(state, identity, ['owner']);
      return operation(state);
    });
  }

  async list(principal: VerifiedPrincipal | null | undefined, householdId: string): Promise<MembershipList> {
    return this.#run(principal, householdId, state => ({ revision: state.membershipRevision, members: [...state.members.values()] }));
  }

  #checkRevision(state: HouseholdState, expected: unknown): void {
    if (expectedRevision(expected) !== state.membershipRevision || state.membershipRevision === Number.MAX_SAFE_INTEGER) {
      throw new ServiceError(412, 'membership_revision_conflict');
    }
  }

  #finish(state: HouseholdState): MembershipList {
    if (![...state.members.values()].some(member => member.active && member.role === 'owner')) {
      throw new ServiceError(403, 'last_owner_required');
    }
    state.membershipRevision++;
    return { revision: state.membershipRevision, members: [...state.members.values()] };
  }

  async set(principal: VerifiedPrincipal | null | undefined, householdId: string, expected: unknown, input: unknown): Promise<MembershipList> {
    return this.#run(principal, householdId, state => {
      this.#checkRevision(state, expected);
      const raw = strictRecord(input, ['tenantId', 'objectId', 'role', 'active']);
      const member: Membership = {
        tenantId: text(raw.tenantId), objectId: text(raw.objectId),
        role: choice(raw.role, ['owner', 'editor', 'player'] as const), active: boolean(raw.active),
      };
      if (member.tenantId !== this.#tenantId) throw new ServiceError(403, 'tenant_forbidden');
      state.members.set(memberKey(member.tenantId, member.objectId), member);
      return this.#finish(state);
    });
  }

  async remove(principal: VerifiedPrincipal | null | undefined, householdId: string, expected: unknown, input: unknown): Promise<MembershipList> {
    return this.#run(principal, householdId, state => {
      this.#checkRevision(state, expected);
      const raw = strictRecord(input, ['tenantId', 'objectId']);
      if (!state.members.delete(memberKey(text(raw.tenantId), text(raw.objectId)))) {
        throw new ServiceError(404, 'member_not_found');
      }
      return this.#finish(state);
    });
  }
}