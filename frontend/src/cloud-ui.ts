import type { CloudContext, CloudIdentity } from './cloud-client';
import { CloudRequestError } from './cloud-client';
import { hostedCloudSelectionKey, hostedIdentityMarker, hostedResetKey } from './hosted-session';
import type { RevisionReference } from '../../shared/class-plan';
import type { ClassSelection } from './class-library';
import { errorMessage, t, type MessageKey } from './i18n';

export interface CloudSelection { id: string; revision: number; published: boolean; cached?: boolean }

export function canEditCloudDraft(context: CloudContext, selection: CloudSelection | null): boolean {
  return ['owner', 'editor'].includes(context.user?.role ?? '') && !selection?.published && !selection?.cached;
}

export function cloudStatusMessage(context: CloudContext): string {
  return t(({ online: 'cloudOnline', offline: 'cloudOffline', 'signin-required': 'cloudSigninRequired', forbidden: 'cloudForbidden' } as const)[context.access]);
}

export function cloudErrorMessage(error: unknown): string {
  if (error instanceof CloudRequestError) {
    if (error.code === 'cancelled') return t('cloudCancelled');
    if (error.code === 'session_changed') return t('cloudIdentityChanged');
    if (error.code === 'network_unavailable') return t('cloudNetworkFailed');
    if (error.code === 'signin_required') return t('cloudSigninRequired');
    if (error.code === 'forbidden') return t('cloudForbidden');
    if (error.code === 'response_too_large') return t('cloudInvalidResponse');
    if (error.serverCode === 'routine_locked') return t('cloudLocked');
    if (['routine_conflict', 'revision_conflict', 'revision_exhausted'].includes(error.serverCode ?? '')) return t('cloudConflict');
    if (['invalid_revision', 'revision_required', 'invalid_routine_state'].includes(error.serverCode ?? '')) return t('cloudHeadRequired');
    if (error.serverCode === 'publication_requires_tracks') return t('cloudSaveFirst');
    if (error.serverCode === 'invalid_asset') return t('cloudIntegrity');
    if (error.serverCode === 'reference_scan_uncertain') return t('audioScanUncertain');
    if (error.serverCode === 'library_delete_unconfigured') return t('audioDeleteUnconfigured');
    const messages: Record<number, MessageKey> = {
      400: 'cloudValidation', 404: 'cloudNotFound', 409: 'cloudUploadConflict', 412: 'cloudConflict',
      413: 'cloudMediaSize', 415: 'cloudUnsupported', 422: 'cloudIntegrity', 423: 'cloudLocked',
      428: 'cloudHeadRequired', 429: 'cloudThrottled', 503: 'cloudUnavailable', 507: 'cloudQuota',
    };
    return t(messages[error.status ?? 0] ?? 'cloudFailed');
  }
  const codes: Record<string, MessageKey> = {
    cloud_invalid_response: 'cloudInvalidResponse', cloud_unsupported_media: 'cloudUnsupported',
    cloud_media_size: 'cloudMediaSize', cloud_head_required: 'cloudHeadRequired', cloud_save_first: 'cloudSaveFirst',
    track_integrity_failed: 'cloudIntegrity', track_conflict: 'cloudTrackConflict',
    class_cache_unavailable: 'classCacheUnavailable', class_reference_unavailable: 'classCacheUnavailable',
    playlist_locked: 'cloudLocked', class_setup_locked: 'cloudLocked',
    playlist_conflict: 'routineConflict', class_setup_conflict: 'routineConflict',
    class_reference_unpublished: 'classReferenceUnpublished',
  };
  const code = error instanceof Error ? error.message : '';
  return codes[code] ? t(codes[code]) : errorMessage(error);
}

type SelectionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const classSelectionStorageKey = 'fitness-class-active';

export function rememberClassSelection(storage: SelectionStorage, owner: CloudIdentity | null, selection: ClassSelection | null): void {
  if (!selection) { storage.removeItem(classSelectionStorageKey); return; }
  storage.setItem(classSelectionStorageKey, JSON.stringify({ owner: owner ? hostedIdentityMarker(owner) : 'local',
    reset: storage.getItem(hostedResetKey), source: selection.source, id: selection.setup.id,
    revision: selection.setup.revision, published: selection.setup.published }));
}

export function recalledClassSelection(storage: SelectionStorage, owner: CloudIdentity | null):
  (RevisionReference & { source: ClassSelection['source'] }) | null {
  try {
    const value = JSON.parse(storage.getItem(classSelectionStorageKey) ?? 'null');
    if (value && value.owner === (owner ? hostedIdentityMarker(owner) : 'local')
      && value.reset === storage.getItem(hostedResetKey) && (!owner || value.reset === null)
      && ['local', 'household'].includes(value.source) && (owner || value.source === 'local')
      && typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value.id)
      && Number.isSafeInteger(value.revision) && value.revision > 0 && typeof value.published === 'boolean'
      && (owner?.role !== 'player' || value.source === 'household' && value.published)) {
      return { source: value.source, id: value.id, revision: value.revision, published: value.published };
    }
  } catch {}
  storage.removeItem(classSelectionStorageKey);
  return null;
}

export function rememberCloudSelection(storage: SelectionStorage, owner: CloudIdentity, selection: CloudSelection | null): void {
  if (!selection) { storage.removeItem(hostedCloudSelectionKey); return; }
  storage.setItem(hostedCloudSelectionKey, JSON.stringify({ owner: hostedIdentityMarker(owner), id: selection.id,
    revision: selection.revision, published: selection.published }));
}

export function recalledCloudSelection(storage: SelectionStorage, owner: CloudIdentity): CloudSelection | null {
  try {
    const value = JSON.parse(storage.getItem(hostedCloudSelectionKey) ?? 'null') as Record<string, unknown> | null;
    if (value && value.owner === hostedIdentityMarker(owner) && typeof value.id === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value.id) && typeof value.published === 'boolean'
      && Number.isSafeInteger(value.revision) && (value.revision as number) > 0
      && (owner.role !== 'player' || value.published)) return { id: value.id, revision: value.revision as number, published: value.published, cached: true };
  } catch {}
  storage.removeItem(hostedCloudSelectionKey);
  return null;
}

export function confirmCloudNavigation(confirm: () => boolean, stop: () => void, navigate: () => void): boolean {
  if (!confirm()) return false;
  stop();
  navigate();
  return true;
}