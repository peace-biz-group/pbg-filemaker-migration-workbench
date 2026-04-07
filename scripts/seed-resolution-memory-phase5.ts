/**
 * Seeds shared_phone resolutions from phase5 high-priority-review-packet.csv
 * Usage: npx tsx scripts/seed-resolution-memory-phase5.ts [outputDir]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
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

function main() {
  let memory = loadMemory(outputDir);
  let seeded = 0;

  for (const row of rows) {
    const reviewId = row[idx('review_id')] ?? '';
    const normalizedPhone = row[idx('normalized_phone')] ?? '';
    const humanDecision = (row[idx('human_decision')] ?? '').trim();
    const chosenCustomerId = (row[idx('chosen_customer_id')] ?? '').trim();
    const reviewerNote = (row[idx('reviewer_note')] ?? '').trim();

    if (!normalizedPhone) continue;

    const hasDecision = humanDecision !== '' && humanDecision !== 'manual_review';
    const certainty = hasDecision ? ('confirmed' as const) : ('low' as const);
    const decision = hasDecision ? humanDecision : 'pending_review';

    const rec: ResolutionRecord = {
      resolution_id: `phase5_${reviewId}`,
      resolution_type: 'shared_phone',
      context_key: `phone:${normalizedPhone}`,
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

  saveMemory(memory, outputDir);
  console.log(`Seeded ${seeded} shared_phone resolutions → ${outputDir}/.decisions/resolution-memory.json`);
}

main();
