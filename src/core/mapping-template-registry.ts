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
  const allFingerprints = Array.from(
    new Set([template.schema_fingerprint, ...template.known_schema_fingerprints]),
  );
  for (const fp of allFingerprints) {
    fingerprint_to_template[fp] = template.template_id;
  }
  return { ...registry, templates, fingerprint_to_template };
}

export function computeAutoApplyEligibility(
  decisions: ColumnDecision[],
): 'full' | 'partial' | 'review_required' {
  if (decisions.length === 0) return 'review_required';
  const lowCount = decisions.filter((d) => d.confidence === 'low').length;
  if (lowCount === 0) return 'full';
  if (lowCount / decisions.length <= 0.2) return 'partial';
  return 'review_required';
}

const DECISIONS_DIR = '.decisions';
const REGISTRY_FILE = 'mapping-template-registry.json';

export function saveRegistry(registry: MappingTemplateRegistry, outputDir: string): void {
  const dir = join(outputDir, DECISIONS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify(registry, null, 2), 'utf-8');
}

export function loadRegistry(outputDir: string): MappingTemplateRegistry {
  const path = join(outputDir, DECISIONS_DIR, REGISTRY_FILE);
  if (!existsSync(path)) return createEmptyRegistry();
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as MappingTemplateRegistry;
  } catch {
    return createEmptyRegistry();
  }
}
