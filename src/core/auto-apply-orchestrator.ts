// src/core/auto-apply-orchestrator.ts
import { enrichRoutingDecisionWithFamily } from './source-routing.js';
import {
  getTemplate,
  loadRegistry as loadTemplateRegistry,
} from './mapping-template-registry.js';
import {
  loadMemory,
  lookupResolution,
  shouldAutoApply,
} from './resolution-memory.js';

export interface AppliedDecision {
  sourceColumn: string;
  canonicalField: string | null;
  confidence: string;
  source: 'template' | 'memory';
}

export interface AutoApplyPreviewResult {
  familyId: string;
  familyCertainty: string;
  templateId: string | null;
  autoApplyEligibility: 'full' | 'partial' | 'review_required' | 'no_template';
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
  const { familyId, certainty: familyCertainty } = enrichRoutingDecisionWithFamily(
    columns,
    encoding,
    hasHeader,
    outputDir,
  );

  // Step 2: Resolve template
  const templateRegistry = loadTemplateRegistry(outputDir);
  const template = getTemplate(schemaFingerprint, templateRegistry);

  // Step 3: Apply template decisions (only confirmed / high — fail-closed for low)
  const appliedDecisions: AppliedDecision[] = [];
  const resolvedColumns = new Set<string>();

  if (template) {
    for (const decision of template.column_decisions) {
      if (decision.confidence === 'low') continue;
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
  const memory = loadMemory(outputDir);
  for (const col of columns) {
    if (resolvedColumns.has(col)) continue;
    const rec = lookupResolution('column_ignore', `column:${col}`, memory);
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

  // Step 5: Collect unresolved columns
  const unresolvedColumns = columns.filter((col) => !resolvedColumns.has(col));

  return {
    familyId,
    familyCertainty,
    templateId: template?.template_id ?? null,
    autoApplyEligibility: template ? template.auto_apply_eligibility : 'no_template',
    appliedDecisions,
    unresolvedColumns,
  };
}
