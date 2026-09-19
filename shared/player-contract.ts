import type { Cue, Routine } from './routine';
import type { ClassAudio, ClassPhase } from './class-plan';

export interface PlayerState {
  status: 'idle' | 'playing' | 'paused' | 'filler' | 'finished' | 'error';
  trackIndex: number;
  elapsed: number;
  duration: number;
  classElapsed: number;
  currentCue: string;
  nextCue: string;
  nextCueIn: number | null;
  nextCueTrackTitle?: string | null;
  fillerRemaining: number | null;
  holding: boolean;
  ducked: boolean;
  beepsMuted: boolean;
  error: string | null;
  phase?: ClassPhase;
  phaseTrackTitle?: string;
  phaseTrackIndex?: number;
  nextPhase?: ClassPhase | null;
  canAdvance?: boolean;
}

export interface Player {
  load(routine: Routine, classAudio?: ClassAudio): Promise<void>;
  advance?(): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  previous?(): Promise<void>;
  next(): Promise<void>;
  seek(seconds: number): Promise<void>;
  updateCues(trackIndex: number, cues: Cue[]): void;
  hold(): void;
  continue(): Promise<void>;
  setVolume(value: number): void;
  setDucked(value: boolean): void;
  setBeepsMuted(value: boolean): void;
  subscribe(listener: (state: PlayerState) => void): () => void;
  dispose(): void;
}