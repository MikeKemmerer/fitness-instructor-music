import type { Filler, Track } from './routine';

export interface PreviewState {
  kind: 'idle' | 'track' | 'filler';
  trackId: string | null;
  playing: boolean;
  loading: boolean;
  elapsed: number;
  duration: number;
  error: string | null;
}

export interface AudioPreview {
  playTrack(track: Track, startSeconds?: number): Promise<void>;
  playFiller(filler: Filler): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  getState(): PreviewState;
  subscribe(listener: (state: PreviewState) => void): () => void;
  dispose(): void;
}

export interface BpmEstimate {
  bpm: number;
  firstBeat: number;
  confidence?: number;
  alternatives?: number[];
}

export interface LoudnessEstimate {
  integratedLufs: number;
  peakDbfs: number;
  targetLufs: number;
  recommendedGain: number;
  limited: boolean;
}