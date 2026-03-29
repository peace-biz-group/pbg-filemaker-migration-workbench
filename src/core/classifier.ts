/**
 * Record classifier — assigns candidate types to each record.
 * Does NOT auto-confirm. Everything is a "candidate".
 *
 * Priority: customer > deal > activity > transaction (configurable).
 * Transaction is deprioritized because FileMaker records typically mix
 * customer + deal + amount fields in one row; treating amount alone as
 * a standalone "transaction" record is premature at this stage.
 */

import type { RawRecord, CandidateType } from '../types/index.js';
import type { WorkbenchConfig, ClassificationRules } from '../config/schema.js';
import { readFileInChunks } from '../io/file-reader.js';
import { writeCsv, appendCsv } from '../io/csv-writer.js';
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

const CANDIDATE_TYPES: CandidateType[] = ['customer', 'deal', 'transaction', 'activity'];

function classifyRecord(
  record: RawRecord,
  rules: ClassificationRules,
): { type: CandidateType; confidence: 'high' | 'medium' | 'low'; reason: string } {
  const fieldMap: Record<string, string[]> = {
    customer: rules.customerFields,
    deal: rules.dealFields,
    transaction: rules.transactionFields,
    activity: rules.activityFields,
  };

  const scores: { type: CandidateType; score: number; total: number; ratio: number }[] = [];
  for (const type of CANDIDATE_TYPES) {
    const fields = fieldMap[type];
    const score = countNonEmptyMatches(record, fields);
    scores.push({ type, score, total: fields.length, ratio: fields.length > 0 ? score / fields.length : 0 });
  }

  // Filter to those meeting minimum threshold
  const viable = scores.filter((s) => s.score >= rules.minFieldsForClassification);

  if (viable.length === 0) {
    return { type: 'quarantine', confidence: 'low', reason: 'insufficient fields for classification' };
  }

  // Sort by: absolute score descending (more matched fields = stronger signal),
  // then by priority order for ties.
  const priorityOrder = rules.priorityOrder;
  viable.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    // Use priority order for ties
    const aPri = priorityOrder.indexOf(a.type);
    const bPri = priorityOrder.indexOf(b.type);
    return (aPri === -1 ? 999 : aPri) - (bPri === -1 ? 999 : bPri);
  });

  const best = viable[0];
  const confidence = best.ratio >= 0.6 ? 'high' : best.ratio >= 0.4 ? 'medium' : 'low';

  // If multiple types have the same top score, confidence is reduced
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

  let isFirst = true;
  let rowCounter = 0;

  await readFileInChunks(filePath, config.chunkSize, async (chunk, _idx) => {
    const classifiedChunk: RawRecord[] = [];
    for (const record of chunk) {
      rowCounter++;
      const result = classifyRecord(record, config.classification);
      breakdown[result.type]++;
      classifiedChunk.push({
        _row: String(rowCounter),
        _candidate_type: result.type,
        _confidence: result.confidence,
        _reason: result.reason,
        ...record,
      });
    }
    if (isFirst) {
      await writeCsv(outputPath, classifiedChunk);
      isFirst = false;
    } else {
      await appendCsv(outputPath, classifiedChunk, Object.keys(classifiedChunk[0] ?? {}));
    }
  });

  return { breakdown, outputPath };
}
