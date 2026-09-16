import type { Role } from '../../shared/routine';
import { ServiceError } from './errors';
import { memberKey, type HouseholdState, type Membership } from './repository';
import { text } from './validation';

declare const verifiedPrincipalBrand: unique symbol;

export interface VerifiedPrincipal {
  readonly [verifiedPrincipalBrand]: true;
  readonly tenantId: string;
  readonly objectId: string;
  readonly scopes: readonly string[];
}

export interface AuthorizationPolicy {
  readonly tenantId: string;
  readonly requiredScope: string;
}

export const READ_ROLES: readonly Role[] = ['owner', 'editor', 'player'];
export const EDIT_ROLES: readonly Role[] = ['owner', 'editor'];

export class Authorization {
  readonly #tenantId: string;
  readonly #requiredScope: string;

  constructor(policy: AuthorizationPolicy) {
    this.#tenantId = text(policy.tenantId);
    this.#requiredScope = text(policy.requiredScope);
  }

  identity(principal: VerifiedPrincipal | null | undefined): string {
    if (!principal || typeof principal.tenantId !== 'string' || !principal.tenantId.trim()
      || typeof principal.objectId !== 'string' || !principal.objectId.trim()
      || !Array.isArray(principal.scopes) || !principal.scopes.every(scope => typeof scope === 'string')) {
      throw new ServiceError(401, 'authentication_required');
    }
    if (principal.tenantId !== this.#tenantId || !principal.scopes.includes(this.#requiredScope)) {
      throw new ServiceError(403, 'scope_or_tenant_forbidden');
    }
    return memberKey(principal.tenantId, principal.objectId);
  }

  member(state: HouseholdState, identity: string, roles: readonly Role[]): Membership {
    const member = state.members.get(identity);
    if (!member || member.active !== true || !roles.includes(member.role)) {
      throw new ServiceError(403, 'membership_forbidden');
    }
    return member;
  }
}