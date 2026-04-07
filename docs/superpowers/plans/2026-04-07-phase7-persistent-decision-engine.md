# Phase 7 Persistent Decision Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement persistent decision engine so that once a judgment is made (column mapping, status meaning, shared phone, ignored columns), it is saved and automatically applied on the next run — eliminating re-review of already-decided cases.

**Architecture:** Three layers — ResolutionMemory (exception judgments), MappingTemplateRegistry (column mapping decisions), FamilyRegistry (file classification). Each is a JSON file under `{outputDir}/.decisions/`. Existing code is modified minimally; new modules are added and connected at existing integration points.

**Tech Stack:** TypeScript, Node.js fs (no DB), vitest for tests. Working directory for implementation: `.worktrees/phase7-persistent-decision-engine`

---

## File Structure

### New files
- `src/core/resolution-memory.ts` — ResolutionMemory CRUD + file I/O
- `src/core/mapping-template-registry.ts` — MappingTemplateRegistry CRUD + file I/O
- `src/core/family-registry.ts` — FamilyRegistry CRUD + file I/O
- `scripts/seed-resolution-memory-phase5.ts` — seeds shared_phone from phase5 CSV
- `scripts/seed-resolution-memory-phase6-status.ts` — seeds status_meaning from phase6 CSV
- `scripts/seed-mapping-templates-260312.ts` — seeds column templates from staging-column-map.csv
- `test/core/resolution-memory.test.ts`
- `test/core/mapping-template-registry.test.ts`
- `test/core/family-registry.test.ts`

### Modified files
- `src/core/review-bundle.ts` — `createReview()` applies column_ignore resolutions; `generateBundle()` stores column decisions as template
- `src/core/source-routing.ts` — `determineRoute()` looks up family registry

---

## Task 1: resolution-memory.ts — Core Module

**Files:**
- Create: `src/core/resolution-memory.ts`
- Create: `test/core/resolution-memory.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/core/resolution-memory.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyMemory,
  lookupResolution,
  addResolution,
  shouldAutoApply,
  saveMemory,
  loadMemory,
  type ResolutionRecord,
} from '../../src/core/resolution-memory.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'resolution-memory-test-'));
});

describe('createEmptyMemory', () => {
  it('returns empty memory with version 1', () => {
    const mem = createEmptyMemory();
    expect(mem.version).toBe('1');
    expect(mem.resolutions).toEqual([]);
  });
});

describe('addResolution + lookupResolution', () => {
  it('returns null when memory is empty', () => {
    const mem = createEmptyMemory();
    const result = lookupResolution('shared_phone', 'phone:09012345678', mem);
    expect(result).toBeNull();
  });

  it('finds a record by type and context_key', () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'shared_phone',
      context_key: 'phone:09012345678',
      family_id: null,
      decision: 'keep_all',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'phone_value',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:phone_normalized',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    const found = lookupResolution('shared_phone', 'phone:09012345678', mem);
    expect(found).not.toBeNull();
    expect(found!.resolution_id).toBe('res_001');
  });

  it('returns null for wrong context_key', () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'shared_phone',
      context_key: 'phone:09012345678',
      family_id: null,
      decision: 'keep_all',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'phone_value',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:phone_normalized',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    expect(lookupResolution('shared_phone', 'phone:OTHER', mem)).toBeNull();
  });

  it('returns null for wrong type', () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'shared_phone',
      context_key: 'phone:09012345678',
      family_id: null,
      decision: 'keep_all',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'phone_value',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:phone_normalized',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    expect(lookupResolution('status_meaning', 'phone:09012345678', mem)).toBeNull();
  });
});

describe('shouldAutoApply', () => {
  it('returns true for confirmed', () => {
    const rec = { certainty: 'confirmed' } as ResolutionRecord;
    expect(shouldAutoApply(rec)).toBe(true);
  });

  it('returns true for high', () => {
    const rec = { certainty: 'high' } as ResolutionRecord;
    expect(shouldAutoApply(rec)).toBe(true);
  });

  it('returns false for low', () => {
    const rec = { certainty: 'low' } as ResolutionRecord;
    expect(shouldAutoApply(rec)).toBe(false);
  });
});

describe('saveMemory + loadMemory', () => {
  it('round-trips through disk', async () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'status_meaning',
      context_key: 'status:済',
      family_id: 'call_history',
      decision: 'completed',
      decision_detail: { normalized_stage: 'completed' },
      certainty: 'confirmed',
      scope: 'global',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:status_value',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    await saveMemory(mem, tmpDir);
    const loaded = await loadMemory(tmpDir);
    expect(loaded.resolutions).toHaveLength(1);
    expect(loaded.resolutions[0].resolution_id).toBe('res_001');
  });

  it('loadMemory returns empty memory if file does not exist', async () => {
    const mem = await loadMemory(tmpDir);
    expect(mem.version).toBe('1');
    expect(mem.resolutions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd .worktrees/phase7-persistent-decision-engine && npm test test/core/resolution-memory.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/resolution-memory.js'`

- [ ] **Step 3: Implement resolution-memory.ts**

```typescript
// src/core/resolution-memory.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test test/core/resolution-memory.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/resolution-memory.ts test/core/resolution-memory.test.ts
git commit -m "feat(phase7): add resolution-memory module with CRUD and file I/O"
```

---

## Task 2: review-bundle.ts — Apply column_ignore Resolutions

**Files:**
- Modify: `src/core/review-bundle.ts` (lines 58-105 in `createReview`)
- Modify: `test/ui/server.test.ts` — add test for column_ignore pre-fill (already existing test may cover)

- [ ] **Step 1: Write the failing test**

Add to `test/core/resolution-memory.test.ts` (or create new test file `test/core/resolution-memory-review-integration.test.ts`):

```typescript
// test/core/resolution-memory-review-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyMemory,
  addResolution,
  saveMemory,
  type ResolutionRecord,
} from '../../src/core/resolution-memory.js';
import { applyColumnIgnoreResolutions } from '../../src/core/review-bundle.js';
import type { ColumnReview } from '../../src/types/review.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'review-resolution-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeColumn(sourceColumn: string): ColumnReview {
  return {
    sourceColumn,
    sampleValues: [],
    missingRate: 0,
    uniqueCount: 0,
    suggestion: {
      semanticField: 'unknown',
      fieldFamily: 'raw_extra',
      section: 'raw_extra_info',
      confidence: 'low',
      reason: 'no match',
    },
    humanSemanticField: null,
    humanFieldFamily: null,
    humanSection: null,
    decision: 'unknown',
  };
}

describe('applyColumnIgnoreResolutions', () => {
  it('sets decision to unused for column_ignore resolution with certainty=confirmed', async () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'column_ignore',
      context_key: 'column:備考',
      family_id: null,
      decision: 'unused',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'global',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:column_name',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    await saveMemory(mem, tmpDir);

    const columns: ColumnReview[] = [makeColumn('備考'), makeColumn('氏名')];
    const result = await applyColumnIgnoreResolutions(columns, tmpDir);

    expect(result[0].decision).toBe('unused');  // 備考 → unused
    expect(result[1].decision).toBe('unknown'); // 氏名 → unchanged
  });

  it('does not apply low-certainty resolutions', async () => {
    let mem = createEmptyMemory();
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'column_ignore',
      context_key: 'column:備考',
      family_id: null,
      decision: 'unused',
      decision_detail: {},
      certainty: 'low',
      scope: 'global',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:column_name',
      source_batch_ids: [],
    };
    mem = addResolution(rec, mem);
    await saveMemory(mem, tmpDir);

    const columns: ColumnReview[] = [makeColumn('備考')];
    const result = await applyColumnIgnoreResolutions(columns, tmpDir);

    expect(result[0].decision).toBe('unknown'); // unchanged — low certainty
  });

  it('returns columns unchanged if no memory file exists', async () => {
    const columns: ColumnReview[] = [makeColumn('備考')];
    const result = await applyColumnIgnoreResolutions(columns, tmpDir);
    expect(result[0].decision).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/core/resolution-memory-review-integration.test.ts`
Expected: FAIL — `applyColumnIgnoreResolutions is not exported from review-bundle.ts`

- [ ] **Step 3: Add applyColumnIgnoreResolutions to review-bundle.ts**

Add the following export to `src/core/review-bundle.ts` (after the existing imports, before `createReview`):

```typescript
import { loadMemory, lookupResolution, shouldAutoApply } from './resolution-memory.js';
import type { ColumnReview } from '../types/review.js';

export async function applyColumnIgnoreResolutions(
  columns: ColumnReview[],
  outputDir: string,
): Promise<ColumnReview[]> {
  const memory = await loadMemory(outputDir);
  return columns.map((col) => {
    const res = lookupResolution('column_ignore', `column:${col.sourceColumn}`, memory);
    if (res && shouldAutoApply(res) && res.decision === 'unused') {
      return { ...col, decision: 'unused' as const };
    }
    return col;
  });
}
```

Then in `createReview()`, call `applyColumnIgnoreResolutions` after building the columns array:

```typescript
// After: const columns = suggestAllColumns(profile.columns, config, filePath);
const columns = await applyColumnIgnoreResolutions(
  suggestAllColumns(profile.columns, config, filePath),
  outputDir,
);
```

Note: `createReview` is already async, so no signature change needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test test/core/resolution-memory-review-integration.test.ts`
Expected: All tests PASS

Run: `npm test` (full suite)
Expected: 369 passed (or more if new tests added)

- [ ] **Step 5: Commit**

```bash
git add src/core/review-bundle.ts test/core/resolution-memory-review-integration.test.ts
git commit -m "feat(phase7): apply column_ignore resolutions in createReview"
```

---

## Task 3: seed-resolution-memory-phase5.ts

**Files:**
- Create: `scripts/seed-resolution-memory-phase5.ts`

Seeds `shared_phone` resolutions from `artifacts/filemaker-audit/solar/260312/phase5/high-priority-review-packet.csv`.
Columns used: `normalized_phone`, `human_decision`, `chosen_customer_id`, `reviewer_note`.
Rows where `human_decision` is blank are seeded as `certainty: 'low'` (awaiting human input).
Rows where `human_decision` is non-blank are seeded as `certainty: 'confirmed'`.

- [ ] **Step 1: Write the script**

```typescript
// scripts/seed-resolution-memory-phase5.ts
/**
 * Seeds shared_phone resolutions from phase5 high-priority-review-packet.csv
 * into {outputDir}/.decisions/resolution-memory.json
 *
 * Usage: npx tsx scripts/seed-resolution-memory-phase5.ts [outputDir]
 * Default outputDir: ./output
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEmptyMemory,
  addResolution,
  loadMemory,
  saveMemory,
  type ResolutionRecord,
} from '../src/core/resolution-memory.js';

const PHASE5_CSV = join(
  import.meta.dirname,
  '../artifacts/filemaker-audit/solar/260312/phase5/high-priority-review-packet.csv',
);
const outputDir = process.argv[2] ?? './output';

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

const lines = readFileSync(PHASE5_CSV, 'utf-8').split('\n').filter(Boolean);
const headers = parseCsvLine(lines[0]);
const idx = (col: string) => headers.indexOf(col);

const rows = lines.slice(1).map((line) => parseCsvLine(line));

async function main() {
  let memory = await loadMemory(outputDir);
  let seeded = 0;

  for (const row of rows) {
    const reviewId = row[idx('review_id')] ?? '';
    const normalizedPhone = row[idx('normalized_phone')] ?? '';
    const humanDecision = (row[idx('human_decision')] ?? '').trim();
    const chosenCustomerId = (row[idx('chosen_customer_id')] ?? '').trim();
    const reviewerNote = (row[idx('reviewer_note')] ?? '').trim();

    if (!normalizedPhone) continue;

    const contextKey = `phone:${normalizedPhone}`;
    const hasDecision = humanDecision !== '' && humanDecision !== 'manual_review';
    const certainty = hasDecision ? 'confirmed' : 'low';
    const decision = hasDecision ? humanDecision : 'pending_review';

    const rec: ResolutionRecord = {
      resolution_id: `phase5_${reviewId}`,
      resolution_type: 'shared_phone',
      context_key: contextKey,
      family_id: 'call_history',
      decision,
      decision_detail: {
        normalized_phone: normalizedPhone,
        chosen_customer_id: chosenCustomerId || null,
        reviewer_note: reviewerNote || null,
        source: 'phase5_high_priority_review',
      },
      certainty,
      scope: 'phone_value',
      decided_at: new Date().toISOString(),
      decided_by: hasDecision ? 'human' : 'auto',
      auto_apply_condition: 'exact_match:phone_normalized',
      source_batch_ids: ['260312'],
      notes: reviewerNote || undefined,
    };

    memory = addResolution(rec, memory);
    seeded++;
  }

  await saveMemory(memory, outputDir);
  console.log(`Seeded ${seeded} shared_phone resolutions → ${outputDir}/.decisions/resolution-memory.json`);
}

main().catch(console.error);
```

- [ ] **Step 2: Run the script (dry-run verification)**

Run: `npx tsx scripts/seed-resolution-memory-phase5.ts ./output`
Expected: `Seeded 462 shared_phone resolutions → ./output/.decisions/resolution-memory.json`

Then verify: `cat ./output/.decisions/resolution-memory.json | node -e "const d=require('fs').readFileSync('/dev/stdin','utf-8'); const m=JSON.parse(d); console.log('count:', m.resolutions.length)"`

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-resolution-memory-phase5.ts
git commit -m "feat(phase7): add seed script for phase5 shared_phone resolutions"
```

---

## Task 4: seed-resolution-memory-phase6-status.ts

**Files:**
- Create: `scripts/seed-resolution-memory-phase6-status.ts`

Seeds `status_meaning` resolutions from `artifacts/filemaker-audit/solar/260312/phase6/status-dictionary-v3.csv`.
Columns: `status_value`, `normalized_stage_v3`, `stage_confidence`.

- [ ] **Step 1: Write the script**

```typescript
// scripts/seed-resolution-memory-phase6-status.ts
/**
 * Seeds status_meaning resolutions from phase6 status-dictionary-v3.csv
 * into {outputDir}/.decisions/resolution-memory.json
 *
 * Usage: npx tsx scripts/seed-resolution-memory-phase6-status.ts [outputDir]
 * Default outputDir: ./output
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addResolution,
  loadMemory,
  saveMemory,
  type ResolutionRecord,
} from '../src/core/resolution-memory.js';

const STATUS_CSV = join(
  import.meta.dirname,
  '../artifacts/filemaker-audit/solar/260312/phase6/status-dictionary-v3.csv',
);
const outputDir = process.argv[2] ?? './output';

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

const lines = readFileSync(STATUS_CSV, 'utf-8').split('\n').filter(Boolean);
const headers = parseCsvLine(lines[0]);
const idx = (col: string) => headers.indexOf(col);
const rows = lines.slice(1).map((line) => parseCsvLine(line));

async function main() {
  let memory = await loadMemory(outputDir);
  let seeded = 0;

  for (const row of rows) {
    const statusValue = row[idx('status_value')] ?? '';
    const normalizedStage = row[idx('normalized_stage_v3')] ?? '';
    const stageConfidence = row[idx('stage_confidence')] ?? 'low';

    if (!statusValue || !normalizedStage) continue;

    const certainty =
      stageConfidence === 'high' ? 'confirmed' :
      stageConfidence === 'medium' ? 'high' : 'low';

    const rec: ResolutionRecord = {
      resolution_id: `phase6_status_${Buffer.from(statusValue).toString('hex').slice(0, 8)}`,
      resolution_type: 'status_meaning',
      context_key: `status:${statusValue}`,
      family_id: null,
      decision: normalizedStage,
      decision_detail: {
        source_value: statusValue,
        normalized_stage: normalizedStage,
        source: 'phase6_status_dictionary_v3',
      },
      certainty,
      scope: 'global',
      decided_at: new Date().toISOString(),
      decided_by: 'human',
      auto_apply_condition: 'exact_match:status_value',
      source_batch_ids: ['260312'],
    };

    memory = addResolution(rec, memory);
    seeded++;
  }

  await saveMemory(memory, outputDir);
  console.log(`Seeded ${seeded} status_meaning resolutions → ${outputDir}/.decisions/resolution-memory.json`);
}

main().catch(console.error);
```

- [ ] **Step 2: Run the script**

Run: `npx tsx scripts/seed-resolution-memory-phase6-status.ts ./output`
Expected: `Seeded 16 status_meaning resolutions → ./output/.decisions/resolution-memory.json`

Then run both seeds in sequence:
```bash
npx tsx scripts/seed-resolution-memory-phase5.ts ./output
npx tsx scripts/seed-resolution-memory-phase6-status.ts ./output
cat ./output/.decisions/resolution-memory.json | node -e "const d=require('fs').readFileSync('/dev/stdin','utf-8'); const m=JSON.parse(d); console.log('total:', m.resolutions.length, 'types:', [...new Set(m.resolutions.map(r=>r.resolution_type))])"
```
Expected: `total: 478 types: ['shared_phone', 'status_meaning']`

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-resolution-memory-phase6-status.ts
git commit -m "feat(phase7): add seed script for phase6 status_meaning resolutions"
```

---

## Task 5: mapping-template-registry.ts — Core Module

**Files:**
- Create: `src/core/mapping-template-registry.ts`
- Create: `test/core/mapping-template-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/core/mapping-template-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyRegistry,
  getTemplate,
  upsertTemplate,
  saveRegistry,
  loadRegistry,
  computeAutoApplyEligibility,
  type MappingTemplate,
  type ColumnDecision,
} from '../../src/core/mapping-template-registry.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'template-registry-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDecision(sourceCol: string, confidence: ColumnDecision['confidence'] = 'confirmed'): ColumnDecision {
  return {
    source_col: sourceCol,
    canonical_field: sourceCol === '備考' ? null : sourceCol,
    inferred_type: 'text',
    normalization_rule: null,
    confidence,
    decided_at: '2026-04-07T00:00:00Z',
    decided_by: 'human',
  };
}

describe('createEmptyRegistry', () => {
  it('returns empty registry', () => {
    const reg = createEmptyRegistry();
    expect(reg.version).toBe('1');
    expect(Object.keys(reg.templates)).toHaveLength(0);
  });
});

describe('upsertTemplate + getTemplate', () => {
  it('returns null for unknown schemaFP', () => {
    const reg = createEmptyRegistry();
    expect(getTemplate('unknown_fp', reg)).toBeNull();
  });

  it('stores and retrieves template by schemaFP', () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'customer_master_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_001',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_decisions: [makeDecision('氏名'), makeDecision('備考')],
      auto_apply_eligibility: 'full',
      known_schema_fingerprints: ['fp_001'],
    };
    reg = upsertTemplate(template, reg);
    const found = getTemplate('fp_001', reg);
    expect(found).not.toBeNull();
    expect(found!.template_id).toBe('customer_master_v1');
  });
});

describe('computeAutoApplyEligibility', () => {
  it('returns full when all decisions are confirmed or high', () => {
    const decisions: ColumnDecision[] = [
      makeDecision('氏名', 'confirmed'),
      makeDecision('電話番号', 'high'),
    ];
    expect(computeAutoApplyEligibility(decisions)).toBe('full');
  });

  it('returns partial when low count <= 20%', () => {
    const decisions: ColumnDecision[] = [
      makeDecision('氏名', 'confirmed'),
      makeDecision('電話番号', 'confirmed'),
      makeDecision('住所', 'confirmed'),
      makeDecision('備考', 'confirmed'),
      makeDecision('メモ', 'low'), // 1/5 = 20%
    ];
    expect(computeAutoApplyEligibility(decisions)).toBe('partial');
  });

  it('returns review_required when low count > 20%', () => {
    const decisions: ColumnDecision[] = [
      makeDecision('A', 'confirmed'),
      makeDecision('B', 'low'),
      makeDecision('C', 'low'), // 2/3 > 20%
    ];
    expect(computeAutoApplyEligibility(decisions)).toBe('review_required');
  });
});

describe('saveRegistry + loadRegistry', () => {
  it('round-trips through disk', async () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'test_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_001',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: null,
      column_decisions: [makeDecision('氏名')],
      auto_apply_eligibility: 'full',
      known_schema_fingerprints: ['fp_001'],
    };
    reg = upsertTemplate(template, reg);
    await saveRegistry(reg, tmpDir);
    const loaded = await loadRegistry(tmpDir);
    expect(Object.keys(loaded.templates)).toHaveLength(1);
    expect(getTemplate('fp_001', loaded)!.template_id).toBe('test_v1');
  });

  it('loadRegistry returns empty registry if file does not exist', async () => {
    const reg = await loadRegistry(tmpDir);
    expect(Object.keys(reg.templates)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test test/core/mapping-template-registry.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Implement mapping-template-registry.ts**

```typescript
// src/core/mapping-template-registry.ts
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ColumnDecision {
  source_col: string;
  canonical_field: string | null;
  inferred_type: string;
  normalization_rule: string | null;
  decompose_to?: string[];
  confidence: 'confirmed' | 'high' | 'low';
  decided_at: string;
  decided_by: 'human' | 'auto';
  source_example?: string;
  notes?: string;
}

export interface MappingTemplate {
  template_id: string;
  family_id: string;
  schema_fingerprint: string;
  version: number;
  parent_template_id?: string;
  created_at: string;
  confirmed_at: string | null;
  column_decisions: ColumnDecision[];
  auto_apply_eligibility: 'full' | 'partial' | 'review_required';
  known_schema_fingerprints: string[];
}

export interface MappingTemplateRegistry {
  version: string;
  templates: Record<string, MappingTemplate>;
  fingerprint_to_template: Record<string, string>;
}

export function createEmptyRegistry(): MappingTemplateRegistry {
  return { version: '1', templates: {}, fingerprint_to_template: {} };
}

export function getTemplate(
  schemaFP: string,
  registry: MappingTemplateRegistry,
): MappingTemplate | null {
  const templateId = registry.fingerprint_to_template[schemaFP];
  if (!templateId) return null;
  return registry.templates[templateId] ?? null;
}

export function upsertTemplate(
  template: MappingTemplate,
  registry: MappingTemplateRegistry,
): MappingTemplateRegistry {
  const templates = { ...registry.templates, [template.template_id]: template };
  const fingerprint_to_template = { ...registry.fingerprint_to_template };
  for (const fp of template.known_schema_fingerprints) {
    fingerprint_to_template[fp] = template.template_id;
  }
  return { ...registry, templates, fingerprint_to_template };
}

export function computeAutoApplyEligibility(
  decisions: ColumnDecision[],
): 'full' | 'partial' | 'review_required' {
  if (decisions.length === 0) return 'full';
  const lowCount = decisions.filter((d) => d.confidence === 'low').length;
  if (lowCount === 0) return 'full';
  if (lowCount / decisions.length <= 0.2) return 'partial';
  return 'review_required';
}

const DECISIONS_DIR = '.decisions';
const REGISTRY_FILE = 'mapping-template-registry.json';

function getRegistryPath(outputDir: string): string {
  return join(outputDir, DECISIONS_DIR, REGISTRY_FILE);
}

export async function saveRegistry(
  registry: MappingTemplateRegistry,
  outputDir: string,
): Promise<void> {
  const dir = join(outputDir, DECISIONS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getRegistryPath(outputDir), JSON.stringify(registry, null, 2), 'utf-8');
}

export async function loadRegistry(outputDir: string): Promise<MappingTemplateRegistry> {
  const path = getRegistryPath(outputDir);
  if (!existsSync(path)) return createEmptyRegistry();
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as MappingTemplateRegistry;
  } catch {
    return createEmptyRegistry();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test test/core/mapping-template-registry.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/mapping-template-registry.ts test/core/mapping-template-registry.test.ts
git commit -m "feat(phase7): add mapping-template-registry module with CRUD and file I/O"
```

---

## Task 6: review-bundle.ts — Pre-fill from Template Registry

**Files:**
- Modify: `src/core/review-bundle.ts`
- Add test to `test/core/mapping-template-registry.test.ts` or new file

- [ ] **Step 1: Write the failing test**

```typescript
// Add to test/core/mapping-template-registry-review-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyRegistry, upsertTemplate, saveRegistry, type MappingTemplate,
} from '../../src/core/mapping-template-registry.js';
import { applyTemplateToColumns } from '../../src/core/review-bundle.js';
import type { ColumnReview } from '../../src/types/review.js';

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'template-review-test-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeColumn(sourceColumn: string): ColumnReview {
  return {
    sourceColumn, sampleValues: [], missingRate: 0, uniqueCount: 0,
    suggestion: { semanticField: 'unknown', fieldFamily: 'raw_extra', section: 'raw_extra_info', confidence: 'low', reason: '' },
    humanSemanticField: null, humanFieldFamily: null, humanSection: null, decision: 'unknown',
  };
}

describe('applyTemplateToColumns', () => {
  it('pre-fills humanSemanticField from confirmed template decision', async () => {
    let reg = createEmptyRegistry();
    const template: MappingTemplate = {
      template_id: 'customer_v1', family_id: 'customer_master',
      schema_fingerprint: 'fp_001', version: 1,
      created_at: '2026-04-07T00:00:00Z', confirmed_at: '2026-04-07T00:00:00Z',
      column_decisions: [
        { source_col: '氏名', canonical_field: 'name', inferred_type: 'name', normalization_rule: 'trim', confidence: 'confirmed', decided_at: '2026-04-07T00:00:00Z', decided_by: 'human' },
        { source_col: '備考', canonical_field: null, inferred_type: 'text', normalization_rule: null, confidence: 'confirmed', decided_at: '2026-04-07T00:00:00Z', decided_by: 'human' },
      ],
      auto_apply_eligibility: 'full',
      known_schema_fingerprints: ['fp_001'],
    };
    reg = upsertTemplate(template, reg);
    await saveRegistry(reg, tmpDir);

    const columns: ColumnReview[] = [makeColumn('氏名'), makeColumn('備考'), makeColumn('住所')];
    const result = await applyTemplateToColumns(columns, 'fp_001', tmpDir);

    expect(result[0].humanSemanticField).toBe('name');   // 氏名 → name
    expect(result[0].decision).toBe('accepted');         // auto-accepted
    expect(result[1].humanSemanticField).toBeNull();     // 備考 → null canonical → unused
    expect(result[1].decision).toBe('unused');
    expect(result[2].humanSemanticField).toBeNull();     // 住所 → no template entry → unchanged
    expect(result[2].decision).toBe('unknown');
  });

  it('returns unchanged columns when no template exists for schemaFP', async () => {
    const columns: ColumnReview[] = [makeColumn('氏名')];
    const result = await applyTemplateToColumns(columns, 'unknown_fp', tmpDir);
    expect(result[0].decision).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/core/mapping-template-registry-review-integration.test.ts`
Expected: FAIL — `applyTemplateToColumns is not exported`

- [ ] **Step 3: Add applyTemplateToColumns to review-bundle.ts**

Add to `src/core/review-bundle.ts`:

```typescript
import { loadRegistry, getTemplate } from './mapping-template-registry.js';

export async function applyTemplateToColumns(
  columns: ColumnReview[],
  schemaFP: string,
  outputDir: string,
): Promise<ColumnReview[]> {
  const registry = await loadRegistry(outputDir);
  const template = getTemplate(schemaFP, registry);
  if (!template) return columns;

  const decisionMap = new Map(template.column_decisions.map((d) => [d.source_col, d]));

  return columns.map((col) => {
    const d = decisionMap.get(col.sourceColumn);
    if (!d || d.confidence === 'low') return col;

    if (d.canonical_field === null) {
      return { ...col, humanSemanticField: null, decision: 'unused' as const };
    }
    return { ...col, humanSemanticField: d.canonical_field, decision: 'accepted' as const };
  });
}
```

In `createReview()`, call `applyTemplateToColumns` after `applyColumnIgnoreResolutions`:

```typescript
const columnsWithResolutions = await applyColumnIgnoreResolutions(
  suggestAllColumns(profile.columns, config, filePath),
  outputDir,
);
const columns = await applyTemplateToColumns(columnsWithResolutions, schemaFingerprint, outputDir);
```

- [ ] **Step 4: Run tests**

Run: `npm test` (full suite)
Expected: 369+ passed

- [ ] **Step 5: Commit**

```bash
git add src/core/review-bundle.ts test/core/mapping-template-registry-review-integration.test.ts
git commit -m "feat(phase7): pre-fill column decisions from mapping template in createReview"
```

---

## Task 7: seed-mapping-templates-260312.ts

**Files:**
- Create: `scripts/seed-mapping-templates-260312.ts`

Seeds column mapping templates from `artifacts/filemaker-audit/solar/260312/staging-column-map.csv`.

- [ ] **Step 1: Check staging-column-map.csv columns**

```bash
head -3 artifacts/filemaker-audit/solar/260312/staging-column-map.csv
```

- [ ] **Step 2: Write the script**

```typescript
// scripts/seed-mapping-templates-260312.ts
/**
 * Seeds mapping templates from 260312 staging-column-map.csv
 * into {outputDir}/.decisions/mapping-template-registry.json
 *
 * Usage: npx tsx scripts/seed-mapping-templates-260312.ts [outputDir]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEmptyRegistry, upsertTemplate, loadRegistry, saveRegistry,
  computeAutoApplyEligibility, type ColumnDecision, type MappingTemplate,
} from '../src/core/mapping-template-registry.js';
import { computeSchemaFingerprint } from '../src/core/review-bundle.js';

const COLUMN_MAP_CSV = join(
  import.meta.dirname,
  '../artifacts/filemaker-audit/solar/260312/staging-column-map.csv',
);
const outputDir = process.argv[2] ?? './output';

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

const lines = readFileSync(COLUMN_MAP_CSV, 'utf-8').split('\n').filter(Boolean);
const headers = parseCsvLine(lines[0]);
const idx = (col: string) => headers.indexOf(col);
const rows = lines.slice(1).map((line) => parseCsvLine(line));

async function main() {
  let registry = await loadRegistry(outputDir);

  // Group rows by source_file (or family_id)
  const byFamily = new Map<string, typeof rows>();
  for (const row of rows) {
    const familyId = row[idx('family_id')] ?? row[idx('source_file')] ?? 'unknown';
    if (!byFamily.has(familyId)) byFamily.set(familyId, []);
    byFamily.get(familyId)!.push(row);
  }

  let seeded = 0;
  for (const [familyId, familyRows] of byFamily) {
    const decisions: ColumnDecision[] = familyRows.map((row) => ({
      source_col: row[idx('source_column')] ?? row[idx('column_name')] ?? '',
      canonical_field: row[idx('canonical_field')] || null,
      inferred_type: row[idx('inferred_type')] ?? 'text',
      normalization_rule: row[idx('normalization_rule')] || null,
      confidence: 'confirmed' as const,
      decided_at: new Date().toISOString(),
      decided_by: 'human' as const,
    })).filter((d) => d.source_col !== '');

    const columnNames = decisions.map((d) => d.source_col);
    const schemaFP = computeSchemaFingerprint(columnNames);

    const template: MappingTemplate = {
      template_id: `${familyId}_v1`,
      family_id: familyId,
      schema_fingerprint: schemaFP,
      version: 1,
      created_at: new Date().toISOString(),
      confirmed_at: new Date().toISOString(),
      column_decisions: decisions,
      auto_apply_eligibility: computeAutoApplyEligibility(decisions),
      known_schema_fingerprints: [schemaFP],
    };

    registry = upsertTemplate(template, registry);
    seeded++;
    console.log(`  ${familyId}: ${decisions.length} columns → template_id=${template.template_id}, eligibility=${template.auto_apply_eligibility}`);
  }

  await saveRegistry(registry, outputDir);
  console.log(`\nSeeded ${seeded} templates → ${outputDir}/.decisions/mapping-template-registry.json`);
}

main().catch(console.error);
```

- [ ] **Step 3: Run and verify**

```bash
npx tsx scripts/seed-mapping-templates-260312.ts ./output
```

Expected output: Template seeding for customer_master, call_history families.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-mapping-templates-260312.ts
git commit -m "feat(phase7): add seed script for 260312 mapping templates"
```

---

## Task 8: family-registry.ts — Core Module

**Files:**
- Create: `src/core/family-registry.ts`
- Create: `test/core/family-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/core/family-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeFileShapeFingerprint,
  detectFamily,
  lookupFingerprint,
  registerFingerprint,
  createDefaultRegistry,
  saveRegistry,
  loadRegistry,
  type FamilyRegistryEntry,
} from '../../src/core/family-registry.js';

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'family-registry-test-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe('computeFileShapeFingerprint', () => {
  it('produces same fingerprint for same columns regardless of order', () => {
    const fp1 = computeFileShapeFingerprint(['氏名', '電話番号', '住所'], 'cp932', true);
    const fp2 = computeFileShapeFingerprint(['住所', '氏名', '電話番号'], 'cp932', true);
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprint for different column sets', () => {
    const fp1 = computeFileShapeFingerprint(['氏名', '電話番号'], 'cp932', true);
    const fp2 = computeFileShapeFingerprint(['氏名', 'メール'], 'cp932', true);
    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprint for different encodings', () => {
    const fp1 = computeFileShapeFingerprint(['氏名'], 'cp932', true);
    const fp2 = computeFileShapeFingerprint(['氏名'], 'utf-8', true);
    expect(fp1).not.toBe(fp2);
  });
});

describe('detectFamily', () => {
  it('detects customer_master from customer columns', () => {
    const result = detectFamily(['氏名', '電話番号', '住所', '会社名', '郵便番号'], createDefaultRegistry());
    expect(result.familyId).toBe('customer_master');
    expect(result.certainty).toBe('high');
  });

  it('detects call_history from call columns', () => {
    const result = detectFamily(['通話日時', '担当者', 'コール結果', '電話番号'], createDefaultRegistry());
    expect(result.familyId).toBe('call_history');
  });

  it('returns unknown for unrecognized columns', () => {
    const result = detectFamily(['AAA', 'BBB', 'CCC'], createDefaultRegistry());
    expect(result.familyId).toBe('unknown');
  });
});

describe('lookupFingerprint + registerFingerprint', () => {
  it('returns null for unknown fingerprint', () => {
    const reg = createDefaultRegistry();
    expect(lookupFingerprint('unknown_fp', reg)).toBeNull();
  });

  it('stores and retrieves entry', () => {
    let reg = createDefaultRegistry();
    const entry: FamilyRegistryEntry = {
      fingerprint: 'fp_001',
      family_id: 'customer_master',
      certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_count: 5,
      encoding: 'cp932',
      has_header: true,
      sample_filename: 'test.csv',
      matched_template_id: null,
    };
    reg = registerFingerprint(entry, reg);
    const found = lookupFingerprint('fp_001', reg);
    expect(found).not.toBeNull();
    expect(found!.family_id).toBe('customer_master');
  });
});

describe('saveRegistry + loadRegistry', () => {
  it('round-trips through disk', async () => {
    let reg = createDefaultRegistry();
    const entry: FamilyRegistryEntry = {
      fingerprint: 'fp_001', family_id: 'customer_master', certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z', column_count: 3, encoding: 'cp932',
      has_header: true, sample_filename: 'test.csv', matched_template_id: null,
    };
    reg = registerFingerprint(entry, reg);
    await saveRegistry(reg, tmpDir);
    const loaded = await loadRegistry(tmpDir);
    expect(lookupFingerprint('fp_001', loaded)!.family_id).toBe('customer_master');
  });

  it('loadRegistry returns default registry if file does not exist', async () => {
    const reg = await loadRegistry(tmpDir);
    expect(reg.version).toBe('1');
    expect(Object.keys(reg.known_fingerprints)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test test/core/family-registry.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Implement family-registry.ts**

```typescript
// src/core/family-registry.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type FamilyId =
  | 'customer_master' | 'call_history' | 'visit_history'
  | 'appo_source' | 'contract' | 'unknown';

export type FamilyCertainty = 'confirmed' | 'high' | 'low' | 'unknown';

export interface FamilyDefinition {
  display_name: string;
  keyword_weights: Record<string, number>;
  threshold: number;
  default_template_id: string | null;
}

export interface FamilyRegistryEntry {
  fingerprint: string;
  family_id: FamilyId;
  certainty: FamilyCertainty;
  confirmed_at: string | null;
  column_count: number;
  encoding: string;
  has_header: boolean;
  sample_filename: string;
  matched_template_id: string | null;
  notes?: string;
}

export interface FamilyRegistry {
  version: string;
  families: Record<FamilyId, FamilyDefinition>;
  known_fingerprints: Record<string, FamilyRegistryEntry>;
}

export function computeFileShapeFingerprint(
  columns: string[],
  encoding: string,
  hasHeader: boolean,
): string {
  const sorted = [...columns].sort().join(',');
  const input = `${sorted}|${columns.length}|${encoding}|${hasHeader ? '1' : '0'}`;
  return createHash('sha256').update(input).digest('hex');
}

const DEFAULT_FAMILIES: Record<FamilyId, FamilyDefinition> = {
  customer_master: {
    display_name: '顧客管理系',
    keyword_weights: {
      '氏名': 0.3, '名前': 0.3, 'フリガナ': 0.2, '電話番号': 0.3, '携帯': 0.2,
      '住所': 0.2, '郵便番号': 0.2, '会社名': 0.2, '法人名': 0.2,
    },
    threshold: 0.5,
    default_template_id: null,
  },
  call_history: {
    display_name: 'コール履歴系',
    keyword_weights: {
      '通話日': 0.4, 'コール日': 0.4, '通話日時': 0.4, '担当者': 0.3,
      '営業担当': 0.3, 'コール結果': 0.4, '架電結果': 0.4,
    },
    threshold: 0.5,
    default_template_id: null,
  },
  visit_history: {
    display_name: '訪問履歴系',
    keyword_weights: { '訪問日': 0.4, '訪問者': 0.3, '訪問結果': 0.4 },
    threshold: 0.5,
    default_template_id: null,
  },
  appo_source: {
    display_name: 'アポ元系',
    keyword_weights: { 'アポ': 0.4, '媒体': 0.3, 'アポ取得': 0.4 },
    threshold: 0.5,
    default_template_id: null,
  },
  contract: {
    display_name: '契約系',
    keyword_weights: { '契約番号': 0.4, '契約日': 0.3, '金額': 0.2 },
    threshold: 0.5,
    default_template_id: null,
  },
  unknown: {
    display_name: '未分類',
    keyword_weights: {},
    threshold: 999,
    default_template_id: null,
  },
};

export function createDefaultRegistry(): FamilyRegistry {
  return {
    version: '1',
    families: DEFAULT_FAMILIES,
    known_fingerprints: {},
  };
}

export function detectFamily(
  columns: string[],
  registry: FamilyRegistry,
): { familyId: FamilyId; certainty: FamilyCertainty; score: number } {
  const scores: [FamilyId, number][] = [];

  for (const [familyId, def] of Object.entries(registry.families) as [FamilyId, FamilyDefinition][]) {
    if (familyId === 'unknown') continue;
    let score = 0;
    for (const col of columns) {
      score += def.keyword_weights[col] ?? 0;
    }
    scores.push([familyId, score]);
  }

  scores.sort((a, b) => b[1] - a[1]);
  const [bestFamily, bestScore] = scores[0] ?? ['unknown', 0];

  const def = registry.families[bestFamily];
  if (!def || bestScore < def.threshold) {
    return { familyId: 'unknown', certainty: 'unknown', score: bestScore };
  }

  const certainty: FamilyCertainty = bestScore >= def.threshold * 1.5 ? 'high' : 'low';
  return { familyId: bestFamily, certainty, score: bestScore };
}

export function lookupFingerprint(
  fp: string,
  registry: FamilyRegistry,
): FamilyRegistryEntry | null {
  return registry.known_fingerprints[fp] ?? null;
}

export function registerFingerprint(
  entry: FamilyRegistryEntry,
  registry: FamilyRegistry,
): FamilyRegistry {
  return {
    ...registry,
    known_fingerprints: { ...registry.known_fingerprints, [entry.fingerprint]: entry },
  };
}

const DECISIONS_DIR = '.decisions';
const REGISTRY_FILE = 'source-family-registry.json';

export async function saveRegistry(registry: FamilyRegistry, outputDir: string): Promise<void> {
  const dir = join(outputDir, DECISIONS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify(registry, null, 2), 'utf-8');
}

export async function loadRegistry(outputDir: string): Promise<FamilyRegistry> {
  const path = join(outputDir, DECISIONS_DIR, REGISTRY_FILE);
  if (!existsSync(path)) return createDefaultRegistry();
  try {
    const loaded = JSON.parse(readFileSync(path, 'utf-8')) as Partial<FamilyRegistry>;
    return {
      version: loaded.version ?? '1',
      families: { ...DEFAULT_FAMILIES, ...(loaded.families ?? {}) },
      known_fingerprints: loaded.known_fingerprints ?? {},
    };
  } catch {
    return createDefaultRegistry();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test test/core/family-registry.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/family-registry.ts test/core/family-registry.test.ts
git commit -m "feat(phase7): add family-registry module for file shape classification"
```

---

## Task 9: source-routing.ts — Family Registry Integration

**Files:**
- Modify: `src/core/source-routing.ts`
- Modify: `src/types/index.ts` — add `familyId?: string` to `SourceRoutingDecision`

- [ ] **Step 1: Read current source-routing.ts**

Read lines 1-50 of `src/core/source-routing.ts` to confirm current `SourceRoutingDecision` interface and `determineRoute()` signature.

- [ ] **Step 2: Write the failing test**

```typescript
// test/core/family-registry-routing-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDefaultRegistry, registerFingerprint, saveRegistry,
  computeFileShapeFingerprint, type FamilyRegistryEntry,
} from '../../src/core/family-registry.js';
import { enrichRoutingDecisionWithFamily } from '../../src/core/source-routing.js';

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'family-routing-test-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe('enrichRoutingDecisionWithFamily', () => {
  it('returns familyId from registry when fingerprint is known', async () => {
    let reg = createDefaultRegistry();
    const fp = computeFileShapeFingerprint(['氏名', '電話番号'], 'cp932', true);
    const entry: FamilyRegistryEntry = {
      fingerprint: fp, family_id: 'customer_master', certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z', column_count: 2, encoding: 'cp932',
      has_header: true, sample_filename: 'test.csv', matched_template_id: null,
    };
    reg = registerFingerprint(entry, reg);
    await saveRegistry(reg, tmpDir);

    const result = await enrichRoutingDecisionWithFamily(['氏名', '電話番号'], 'cp932', true, tmpDir);
    expect(result.familyId).toBe('customer_master');
    expect(result.certainty).toBe('confirmed');
  });

  it('auto-detects family when fingerprint is unknown', async () => {
    const result = await enrichRoutingDecisionWithFamily(
      ['氏名', '電話番号', '住所', '会社名', '郵便番号'], 'cp932', true, tmpDir,
    );
    expect(result.familyId).toBe('customer_master');
    expect(result.certainty).toBe('high');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test test/core/family-registry-routing-integration.test.ts`
Expected: FAIL

- [ ] **Step 4: Add enrichRoutingDecisionWithFamily to source-routing.ts**

Add the following export to `src/core/source-routing.ts`:

```typescript
import {
  loadRegistry as loadFamilyRegistry,
  lookupFingerprint,
  detectFamily,
  computeFileShapeFingerprint,
} from './family-registry.js';

export async function enrichRoutingDecisionWithFamily(
  columns: string[],
  encoding: string,
  hasHeader: boolean,
  outputDir: string,
): Promise<{ familyId: string; certainty: string }> {
  const fp = computeFileShapeFingerprint(columns, encoding, hasHeader);
  const registry = await loadFamilyRegistry(outputDir);
  const known = lookupFingerprint(fp, registry);
  if (known) {
    return { familyId: known.family_id, certainty: known.certainty };
  }
  const detected = detectFamily(columns, registry);
  return { familyId: detected.familyId, certainty: detected.certainty };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: 369+ PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/source-routing.ts test/core/family-registry-routing-integration.test.ts
git commit -m "feat(phase7): enrich routing decision with family registry lookup"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Source Family Registry designed and implemented (Task 8, 9)
- ✅ Mapping Template Registry designed and implemented (Task 5, 6, 7)
- ✅ Resolution Memory designed and implemented (Task 1, 2, 3, 4)
- ✅ Rerun idempotency: resolution memory + template pre-fill eliminates re-review
- ✅ Manual review minimization: column_ignore resolutions and template pre-fill

**Type consistency:**
- `ResolutionRecord` used consistently in Task 1, 2, 3, 4
- `MappingTemplate`/`ColumnDecision` used consistently in Task 5, 6, 7
- `FamilyRegistry`/`FamilyRegistryEntry` used consistently in Task 8, 9
- `applyColumnIgnoreResolutions` and `applyTemplateToColumns` both return `Promise<ColumnReview[]>`

**No placeholders:** All code blocks are complete.
