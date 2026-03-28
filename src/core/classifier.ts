/**
 * Record classifier — assigns candidate types to each record.
 * Does NOT auto-confirm. Everything is a "candidate".
 */

import type { RawRecord, CandidateType } from '../types/index.js';
import type { WorkbenchConfig, ClassificationRules } from '../config/schema.js';
import { readFileInChunks } from '../io/file-reader.js';
import { writeCsv } from '../io/csv-writer.js';
import { join } from 'node:path';
import { ensureOutputDir } from '../io/report-writer.js';

function countNonEmptyMatches(record: RawRecord, fieldPatterns: string[]): number {
  let count = 0;
  for (const pattern of fieldPatterns) {
    for (const [key, val] of Object.entries(record)) {
      if (key.toLowerCase() === pattern.toLowerCase() && val?.trim()) {
        count++;
        break;
      }
    }
  }
  return count;
}

function classifyRecord(
  record: RawRecord,
  rules: ClassificationRules,
): { type: CandidateType; confidence: 'high' | 'medium' | 'low'; reason: string } {
  const scores: { type: CandidateType; score: number; total: number }[] = [
    { type: 'customer', score: countNonEmptyMatches(record, rules.customerFields), total: rules.customerFields.length },
    { type: 'deal', score: countNonEmptyMatches(record, rules.dealFields), total: rules.dealFields.length },
    { type: 'transaction', score: countNonEmptyMatches(record, rules.transactionFields), total: rules.transactionFields.length },
    { type: 'activity', score: countNonEmptyMatches(record, rules.activityFields), total: rules.activityFields.length },
  ];

  // Filter to those meeting minimum threshold
  const viable = scores.filter((s) => s.score >= rules.minFieldsForClassification);

  if (viable.length === 0) {
    return { type: 'quarantine', confidence: 'low', reason: 'insufficient fields for classification' };
  }

  // Pick highest ratio
  viable.sort((a, b) => b.score / b.total - a.score / a.total);
  const best = viable[0];
  const ratio = best.score / best.total;
  const confidence = ratio >= 0.6 ? 'high' : ratio >= 0.4 ? 'medium' : 'low';

  // If multiple types have the same top score, confidence is lower
  const tiedCount = viable.filter((v) => v.score === best.score).length;
  const finalConfidence = tiedCount > 1 && confidence === 'high' ? 'medium' : confidence;

  return {
    type: best.type,
    confidence: finalConfidence,
    reason: `${best.score}/${best.total} fields matched for ${best.type}`,
  };
}

export interface ClassifyResult {
  breakdown: Record<CandidateType, number>;
  outputPath: string;
}

export async function classifyFile(
  filePath: string,
  config: WorkbenchConfig,
): Promise<ClassifyResult> {
  ensureOutputDir(config.outputDir);
  const outputPath = join(config.outputDir, 'classified.csv');

  const breakdown: Record<CandidateType, number> = {
    customer: 0,
    deal: 0,
    transaction: 0,
    activity: 0,
    quarantine: 0,
  };

  const allClassified: RawRecord[] = [];
  let rowCounter = 0;

  await readFileInChunks(filePath, config.chunkSize, async (chunk, _idx) => {
    for (const record of chunk) {
      rowCounter++;
      const result = classifyRecord(record, config.classification);
      breakdown[result.type]++;
      allClassified.push({
        _row: String(rowCounter),
        _candidate_type: result.type,
        _confidence: result.confidence,
        _reason: result.reason,
        ...record,
      });
    }
  });

  await writeCsv(outputPath, allClassified);

  return { breakdown, outputPath };
}
