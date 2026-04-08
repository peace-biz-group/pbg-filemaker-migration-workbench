// src/core/auto-apply-orchestrator.ts
import { enrichRoutingDecisionWithFamily } from './source-routing.js';
import {
  getTemplate,
  loadRegistry as loadTemplateRegistry,
  type MappingTemplate,
} from './mapping-template-registry.js';
import {
  loadMemory,
  lookupResolution,
  shouldAutoApply,
} from './resolution-memory.js';
import { type FamilyCertainty } from './family-registry.js';

type AutoApplyEligibility = MappingTemplate['auto_apply_eligibility'] | 'no_template';

export interface AppliedDecision {
  sourceColumn: string;
  canonicalField: string | null;
  confidence: string;
  source: 'template' | 'memory';
}

export interface AutoApplyPreviewResult {
  familyId: string;
  familyCertainty: FamilyCertainty;
  templateId: string | null;
  autoApplyEligibility: AutoApplyEligibility;
  appliedDecisions: AppliedDecision[];
  unresolvedColumns: string[];
}

/**
 * auto-apply の preview を返す。
 * 1. FamilyRegistry からファミリーを解決
 * 2. MappingTemplateRegistry からテンプレートを解決し、high/confirmed の決定を適用
 * 3. ResolutionMemory の column_ignore を適用
 * 4. 未解決の列を配列で返す（fail-closed）
 *
 * 注意: run-scoped な effective mapping とは別物。長期再利用の決定層。
 */
export function runAutoApplyPreview(
  columns: string[],
  encoding: string,
  hasHeader: boolean,
  schemaFingerprint: string,
  outputDir: string,
): AutoApplyPreviewResult {
  // Step 1: Resolve family
  const routingResult = enrichRoutingDecisionWithFamily(
    columns,
    encoding,
    hasHeader,
    outputDir,
  );
  const familyId = routingResult.familyId;
  const familyCertainty = routingResult.certainty as FamilyCertainty;

  // Step 2: Resolve template
  const templateRegistry = loadTemplateRegistry(outputDir);
  const template = getTemplate(schemaFingerprint, templateRegistry);

  // テンプレートが見つかった場合はそちらの family_id を優先する。
  // テンプレートは schemaFingerprint で厳密に照合されるため、
  // 列ベースのキーワード検出より信頼度が高い。
  const resolvedFamilyId = template?.family_id ?? familyId;

  // Step 3: Apply template decisions (only confirmed / high — fail-closed for low)
  // Only apply decisions for columns that actually exist in the input file.
  const appliedDecisions: AppliedDecision[] = [];
  const resolvedColumns = new Set<string>();
  const inputColumnSet = new Set(columns);

  if (template) {
    for (const decision of template.column_decisions) {
      if (decision.confidence === 'low') continue;
      if (!inputColumnSet.has(decision.source_col)) continue;
      appliedDecisions.push({
        sourceColumn: decision.source_col,
        canonicalField: decision.canonical_field,
        confidence: decision.confidence,
        source: 'template',
      });
      resolvedColumns.add(decision.source_col);
    }
  }

  // Step 4: Apply resolution memory (column_ignore type only)
  // resolvedFamilyId を渡して family スコープ優先・グローバルフォールバックで検索する
  const memory = loadMemory(outputDir);
  for (const col of columns) {
    if (resolvedColumns.has(col)) continue;
    const rec = lookupResolution('column_ignore', `column:${col}`, memory, resolvedFamilyId);
    if (rec && shouldAutoApply(rec)) {
      appliedDecisions.push({
        sourceColumn: col,
        canonicalField: null,
        confidence: rec.certainty,
        source: 'memory',
      });
      resolvedColumns.add(col);
    }
  }

  // Step 4b: Apply resolution memory (column_canonical type)
  // Family-scoped records are only applied when the current file's family matches.
  for (const col of columns) {
    if (resolvedColumns.has(col)) continue;
    const rec = lookupResolution('column_canonical', `column:${col}`, memory);
    if (!rec || !shouldAutoApply(rec)) continue;
    if (rec.scope === 'family') {
      // fail-closed: skip when family is unknown or record targets a different family
      if (familyId === 'unknown' || rec.family_id === null || rec.family_id !== familyId) continue;
    }
    appliedDecisions.push({
      sourceColumn: col,
      canonicalField: rec.decision,
      confidence: rec.certainty,
      source: 'memory',
    });
    resolvedColumns.add(col);
  }

  // Step 5: Collect unresolved columns
  const unresolvedColumns = columns.filter((col) => !resolvedColumns.has(col));

  return {
    familyId: resolvedFamilyId,
    familyCertainty,
    templateId: template?.template_id ?? null,
    autoApplyEligibility: template ? template.auto_apply_eligibility : 'no_template',
    appliedDecisions,
    unresolvedColumns,
  };
}
