import { ServiceError } from '../src/errors';
import { memberKey, type HouseholdRepository, type HouseholdState, type Membership } from '../src/repository';

export interface TestHouseholdSeed {
  householdId: string;
  members: readonly Membership[];
}

export class TestOnlyInMemoryRepository implements HouseholdRepository {
  readonly #states = new Map<string, HouseholdState>();
  #tail: Promise<void> = Promise.resolve();

  constructor(seeds: readonly TestHouseholdSeed[] = []) {
    for (const seed of seeds) {
      if (this.#states.has(seed.householdId)) throw new Error('Duplicate test household');
      this.#states.set(seed.householdId, {
        membershipRevision: 1,
        members: new Map(seed.members.map(member => [memberKey(member.tenantId, member.objectId), structuredClone(member)])),
        routines: new Map(),
      });
    }
  }

  transact<Result>(householdId: string, operation: (state: HouseholdState) => Result): Promise<Result> {
    const pending = this.#tail.then(() => {
      const state = this.#states.get(householdId);
      if (!state) throw new ServiceError(404, 'household_not_found');
      const working = structuredClone(state);
      const result = operation(working);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        throw new Error('Test transactions must be synchronous');
      }
      const detachedResult = structuredClone(result);
      const detachedState = structuredClone(working);
      this.#states.set(householdId, detachedState);
      return detachedResult;
    });
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}