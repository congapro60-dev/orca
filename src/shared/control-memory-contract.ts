export type TaskJournal = {
  journalId: string
  logicalWorkSessionId: string
  projectId: string
  objective: string
  workEventSequences: number[]
  workItemIds: string[]
  executionIds: string[]
  artifactRefs: string[]
  evidenceRefs: string[]
  decisionEventSequences: number[]
  failureEventSequences: number[]
  verificationEventSequences: number[]
  revision: number
  contentHash: string
  createdAt: string
}

export type MemoryClass = 'WORKING' | 'CANDIDATE' | 'CANONICAL'
export type CandidateMemoryStatus = 'CANDIDATE' | 'REJECTED' | 'PROMOTED' | 'SUPERSEDED'
export type CandidateMemory = {
  memoryCandidateId: string
  projectId: string
  logicalWorkSessionId: string
  sourceJournalId: string
  statement: string
  kind: string
  sourceEvidenceRefs: string[]
  sourceArtifactRefs: string[]
  status: CandidateMemoryStatus
  revision: number
  contentHash: string
  createdAt: string
  updatedAt: string
}

export type CanonicalMemory = {
  projectId: string
  key: string
  statement: string
  kind: string
  sourceCandidateId: string
  sourceEvidenceRefs: string[]
  sourceArtifactRefs: string[]
  revision: number
  contentHash: string
  updatedAt: string
}
