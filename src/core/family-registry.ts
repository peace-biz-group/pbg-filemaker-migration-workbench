import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type FamilyId =
  | 'customer_master'
  | 'call_history'
  | 'visit_history'
  | 'appo_source'
  | 'contract'
  | 'unknown';

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
  families: Record<string, FamilyDefinition>;
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

const DEFAULT_FAMILIES: Record<string, FamilyDefinition> = {
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
  const scores: [string, number][] = [];

  for (const [familyId, def] of Object.entries(registry.families)) {
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

  return { familyId: bestFamily as FamilyId, certainty: 'low', score: bestScore };
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

export function saveRegistry(registry: FamilyRegistry, outputDir: string): void {
  const dir = join(outputDir, DECISIONS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify(registry, null, 2), 'utf-8');
}

export function loadRegistry(outputDir: string): FamilyRegistry {
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
