/**
 * Seeds status_meaning resolutions from phase6 status-dictionary-v3.csv
 * Usage: npx tsx scripts/seed-resolution-memory-phase6-status.ts [outputDir]
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

function main() {
  let memory = loadMemory(outputDir);
  let seeded = 0;

  for (const row of rows) {
    const statusValue = row[idx('status_value')] ?? '';
    const normalizedStage = row[idx('normalized_stage_v3')] ?? '';
    const stageConfidence = row[idx('stage_confidence')] ?? 'low';

    if (!statusValue || !normalizedStage) continue;

    const certainty =
      stageConfidence === 'high' ? ('confirmed' as const) :
      stageConfidence === 'medium' ? ('high' as const) : ('low' as const);

    const idHex = Buffer.from(statusValue, 'utf-8').toString('hex').slice(0, 8);
    const rec: ResolutionRecord = {
      resolution_id: `phase6_status_${idHex}`,
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

  saveMemory(memory, outputDir);
  console.log(`Seeded ${seeded} status_meaning resolutions → ${outputDir}/.decisions/resolution-memory.json`);
}

main();
