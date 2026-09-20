import { admitted, type ReferenceClaims } from './admission';
import type { DocumentsAdmission } from './cosmos-documents';
import { QuotaBudget } from './quota';
import type { BlobStore } from './store';

// Keeps admission gates and quota unified on Blob (the pre-existing, still-authoritative
// implementation) while document storage moves to Cosmos per kind. This is the transitional
// wiring: it deliberately does NOT use the Cosmos admission/quota built for the eventual
// full cutover, because library browsing/GC (library-management.ts) and fillers still read
// and write the Blob gates -- splitting admission across two stores would let the Blob-side
// garbage collector delete an asset still claimed by a Cosmos-backed document, or vice versa.
export function blobDocumentsAdmission(store: BlobStore): DocumentsAdmission<ReferenceClaims> {
  const budget = new QuotaBudget(store);
  return { charge: (bytes, options) => budget.charge(bytes, options), admitted: action => admitted(store, action) };
}
