import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type ResolutionType =
  | 'shared_phone'
  | 'phone_exception'
  | 'status_meaning'
  | 'customer_deal_boundary'
  | 'parent_child_classification'
  | 'column_ignore'
  | 'encoding_exception'
  | 'merge_policy';

export type ResolutionCertainty = 'confirmed' | 'high' | 'low';
export type ResolutionScope = 'phone_value' | 'status_value' | 'family' | 'schema_fp' | 'global';
export type DecidedBy = 'human' | 'auto';

export interface ResolutionRecord {
  resolution_id: string;
  resolution_type: ResolutionType;
  context_key: string;
  family_id: string | null;
  decision: string;
  decision_detail: Record<string, unknown>;
  certainty: ResolutionCertainty;
  scope: ResolutionScope;
  decided_at: string;
  decided_by: DecidedBy;
  auto_apply_condition: string;
  source_batch_ids: string[];
  notes?: string;
  deleted_at?: string;
}

export interface ResolutionMemory {
  version: string;
  resolutions: ResolutionRecord[];
}

export function createEmptyMemory(): ResolutionMemory {
  return { version: '1', resolutions: [] };
}

export function lookupResolution(
  type: ResolutionType,
  contextKey: string,
  memory: ResolutionMemory,
): ResolutionRecord | null {
  return (
    memory.resolutions.find(
      (r) => r.resolution_type === type && r.context_key === contextKey && !r.deleted_at,
    ) ?? null
  );
}

export function addResolution(record: ResolutionRecord, memory: ResolutionMemory): ResolutionMemory {
  const filtered = memory.resolutions.filter((r) => r.resolution_id !== record.resolution_id);
  return { ...memory, resolutions: [...filtered, record] };
}

export function shouldAutoApply(record: ResolutionRecord): boolean {
  return record.certainty === 'confirmed' || record.certainty === 'high';
}

const DECISIONS_DIR = '.decisions';
const MEMORY_FILE = 'resolution-memory.json';

function getMemoryPath(outputDir: string): string {
  return join(outputDir, DECISIONS_DIR, MEMORY_FILE);
}

export async function saveMemory(memory: ResolutionMemory, outputDir: string): Promise<void> {
  const dir = join(outputDir, DECISIONS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getMemoryPath(outputDir), JSON.stringify(memory, null, 2), 'utf-8');
}

export async function loadMemory(outputDir: string): Promise<ResolutionMemory> {
  const path = getMemoryPath(outputDir);
  if (!existsSync(path)) return createEmptyMemory();
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ResolutionMemory;
  } catch {
    return createEmptyMemory();
  }
}
