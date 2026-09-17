import type { CloudAsset } from '../../../shared/cloud-contract';
import { allRoutineFillers, type Filler, type Routine, type Track } from '../../../shared/routine';
import { strictRecord } from '../validation';
import { ApiError, LIMITS } from './config';
import { CloudFillers } from './fillers';
import { CloudMedia, parseAsset } from './media';
import { encode } from './store';

export function boundedContent<Value>(value: Value): Value {
  if (encode(value).length > LIMITS.jsonBytes) throw new ApiError(413, 'body_too_large');
  return value;
}

export function routineFillers(routine: Routine): Filler[] {
  return allRoutineFillers(routine);
}

export async function resolveFillers(fillers: Filler[], library: CloudFillers): Promise<void> {
  for (const filler of fillers) {
    if (filler.sound === 'recording') filler.recording = await library.resolve(filler.recording);
  }
}

export function fillerAssetIds(fillers: Filler[]): string[] {
  return fillers.flatMap(filler => filler.sound === 'recording' && filler.recording ? [filler.recording.asset.id] : []);
}

export async function resolveMedia(input: unknown, tracks: Track[], catalog: CloudMedia): Promise<Record<string, CloudAsset>> {
  const entries = strictRecord(input, tracks.map(track => track.id));
  const media: Record<string, CloudAsset> = Object.create(null);
  const checked = new Map<string, CloudAsset>();
  for (const [entryId, descriptor] of Object.entries(entries)) {
    const asset = parseAsset(descriptor);
    const actual = checked.get(asset.id) ?? (await catalog.catalog(asset.id)).asset;
    if (asset.id !== actual.id || asset.sha256 !== actual.sha256 || asset.bytes !== actual.bytes || asset.contentType !== actual.contentType) {
      throw new ApiError(400, 'invalid_asset');
    }
    checked.set(asset.id, actual);
    media[entryId] = { ...actual };
  }
  return media;
}