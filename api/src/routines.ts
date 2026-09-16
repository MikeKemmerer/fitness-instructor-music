import type { Role, Routine } from '../../shared/routine';
import { Authorization, EDIT_ROLES, READ_ROLES, type AuthorizationPolicy, type VerifiedPrincipal } from './auth';
import { ServiceError } from './errors';
import type { HouseholdRepository, HouseholdState, RoutineHead } from './repository';
import { expectedRevision, parseRoutineContent, text, type RoutineContent } from './validation';

type Principal = VerifiedPrincipal | null | undefined;

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision === Number.MAX_SAFE_INTEGER) {
    throw new ServiceError(412, 'revision_exhausted');
  }
  return revision + 1;
}

function contentOf(routine: Routine): RoutineContent {
  const { id, revision, locked, published, ...content } = routine;
  return parseRoutineContent(content);
}

function freezePublication(routine: Routine): Routine {
  for (const track of routine.tracks) {
    for (const cue of track.cues) {
      Object.freeze(cue.anchor);
      Object.freeze(cue);
    }
    Object.freeze(track.cues);
    Object.freeze(track);
  }
  Object.freeze(routine.tracks);
  Object.freeze(routine.filler);
  return Object.freeze(routine);
}

export class RoutineService {
  readonly #authorization: Authorization;

  constructor(readonly repository: HouseholdRepository, policy: AuthorizationPolicy) {
    this.#authorization = new Authorization(policy);
  }

  #run<Result>(principal: Principal, householdId: string, roles: readonly Role[], operation: (state: HouseholdState) => Result): Promise<Result> {
    const identity = this.#authorization.identity(principal);
    const household = text(householdId);
    return this.repository.transact(household, state => {
      this.#authorization.member(state, identity, roles);
      return operation(state);
    });
  }

  #head(state: HouseholdState, id: string): RoutineHead {
    const head = state.routines.get(text(id));
    if (!head || head.deleted) throw new ServiceError(404, 'routine_not_found');
    return head;
  }

  #create(state: HouseholdState, content: RoutineContent): Routine {
    const id = crypto.randomUUID();
    if (state.routines.has(id)) throw new ServiceError(412, 'routine_id_conflict');
    const draft: Routine = { ...content, id, revision: 1, locked: false, published: false };
    state.routines.set(id, { draft, publications: new Map(), deleted: false });
    return draft;
  }

  async create(principal: Principal, householdId: string, input: unknown): Promise<Routine> {
    return this.#run(principal, householdId, EDIT_ROLES, state => this.#create(state, parseRoutineContent(input)));
  }

  async getDraft(principal: Principal, householdId: string, id: string): Promise<Routine> {
    return this.#run(principal, householdId, EDIT_ROLES, state => this.#head(state, id).draft);
  }

  async listDrafts(principal: Principal, householdId: string): Promise<Routine[]> {
    return this.#run(principal, householdId, EDIT_ROLES, state => [...state.routines.values()].filter(head => !head.deleted).map(head => head.draft));
  }

  #publication(head: RoutineHead, revision?: number): Routine {
    const selected = revision === undefined ? head.publishedRevision : expectedRevision(revision);
    const publication = selected === undefined ? undefined : head.publications.get(selected);
    if (!publication) throw new ServiceError(404, 'publication_not_found');
    return publication;
  }

  async getPublished(principal: Principal, householdId: string, id: string, revision?: number): Promise<Routine> {
    const publication = await this.#run(principal, householdId, READ_ROLES, state => this.#publication(this.#head(state, id), revision));
    return freezePublication(publication);
  }

  async listPublished(principal: Principal, householdId: string): Promise<Routine[]> {
    const publications = await this.#run(principal, householdId, READ_ROLES, state => [...state.routines.values()]
      .filter(head => !head.deleted && head.publishedRevision !== undefined).map(head => this.#publication(head)));
    return publications.map(freezePublication);
  }

  async #mutate<Result>(principal: Principal, householdId: string, id: string, expected: unknown, allowLocked: boolean,
    operation: (head: RoutineHead, revision: number) => Result): Promise<Result> {
    return this.#run(principal, householdId, EDIT_ROLES, state => {
      const head = this.#head(state, id);
      const revision = expectedRevision(expected);
      if (head.draft.locked && !allowLocked) throw new ServiceError(423, 'routine_locked');
      if (revision !== head.draft.revision) throw new ServiceError(412, 'revision_conflict');
      return operation(head, nextRevision(revision));
    });
  }

  async save(principal: Principal, householdId: string, id: string, expected: unknown, input: unknown): Promise<Routine> {
    return this.#mutate(principal, householdId, id, expected, false, (head, revision) => {
      head.draft = { ...parseRoutineContent(input), id: head.draft.id, revision, locked: false, published: false };
      return head.draft;
    });
  }

  async publish(principal: Principal, householdId: string, id: string, expected: unknown): Promise<Routine> {
    const publication = await this.#mutate(principal, householdId, id, expected, false, (head, revision) => {
      const content = contentOf(head.draft);
      if (content.tracks.length === 0) throw new ServiceError(400, 'publication_requires_tracks');
      if (head.publications.has(revision)) throw new ServiceError(412, 'publication_exists');
      const snapshot: Routine = { ...content, id: head.draft.id, revision, locked: false, published: true };
      head.publications.set(revision, snapshot);
      head.publishedRevision = revision;
      head.draft.revision = revision;
      return snapshot;
    });
    return freezePublication(publication);
  }

  async lock(principal: Principal, householdId: string, id: string, expected: unknown): Promise<Routine> {
    return this.#mutate(principal, householdId, id, expected, true, (head, revision) => {
      head.draft.locked = true;
      head.draft.revision = revision;
      return head.draft;
    });
  }

  async unlock(principal: Principal, householdId: string, id: string, expected: unknown): Promise<Routine> {
    return this.#mutate(principal, householdId, id, expected, true, (head, revision) => {
      head.draft.locked = false;
      head.draft.revision = revision;
      return head.draft;
    });
  }

  async delete(principal: Principal, householdId: string, id: string, expected: unknown): Promise<{ id: string; revision: number }> {
    return this.#mutate(principal, householdId, id, expected, false, (head, revision) => {
      head.deleted = true;
      head.draft.revision = revision;
      return { id: head.draft.id, revision };
    });
  }

  async duplicate(principal: Principal, householdId: string, id: string, source: 'draft' | number = 'draft'): Promise<Routine> {
    return this.#run(principal, householdId, EDIT_ROLES, state => {
      const head = this.#head(state, id);
      const routine = source === 'draft' ? head.draft : this.#publication(head, expectedRevision(source));
      return this.#create(state, contentOf(routine));
    });
  }
}