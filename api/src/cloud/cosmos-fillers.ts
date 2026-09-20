import type { FillerAnalysis } from '../../../shared/cloud-contract';
import type { FillerRecording } from '../../../shared/routine';

// Consolidates the Blob backend's three separate namespaces (fillers/records/{id},
// fillers/analysis/{id}, library/deleted-fillers/{id}) into one item per filler id.
export interface CosmosFillerItem {
  id: string;
  recording: FillerRecording;
  archived: boolean;
  deleted?: { revision: number };
  analysis?: FillerAnalysis;
}
