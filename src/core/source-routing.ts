import { basename, resolve } from 'node:path';
import type { WorkbenchConfig } from '../config/schema.js';
import { globMatch } from './column-mapper.js';
import { loadProfiles, matchProfile } from '../file-profiles/index.js';
import type { SourceRoutingDecision, SourceRoutingResolvedFrom } from '../types/index.js';

const CUSTOMER_SIGNAL_PATTERNS = [
  /顧客/i,
  /お客様id/i,
  /契約者/i,
  /申込者/i,
  /電話番号/i,
  /メール/i,
  /住所/i,
  /設置住所/i,
  /設置電話番号/i,
  /営業担当/i,
];

function childColumnNames(columns: string[]): string[] {
  return columns.filter((col) => col.includes('::'));
}

function buildDecision(
  mode: 'mainline' | 'archive',
  reasonCode: SourceRoutingDecision['reasonCode'],
  reason: string,
  columns: string[],
  extras?: Partial<SourceRoutingDecision>,
): SourceRoutingDecision {
  const childColumns = childColumnNames(columns);
  return {
    mode,
    reasonCode,
    reason,
    hasChildColumns: childColumns.length > 0,
    childColumnCount: childColumns.length,
    childColumnNames: childColumns,
    mixedParentChildExport: false,
    ...extras,
  };
}

function withRoutingMeta(
  decision: SourceRoutingDecision,
  lookupUsedSourceName: string,
  routingResolvedFrom: SourceRoutingResolvedFrom,
): SourceRoutingDecision {
  return { ...decision, lookupUsedSourceName, routingResolvedFrom };
}

export function analyzeSourceRouting(
  filePath: string,
  columns: string[],
  config: WorkbenchConfig,
  options?: {
    isHeaderless?: boolean;
    /** glob / diffKeys / profile ファイル名マッチに使うパス */
    matchFilePathOverride?: string;
    /** config.inputs[].path の突き合わせに使うパス（省略時は matchFilePathOverride ?? filePath） */
    inputLookupPath?: string;
  },
): SourceRoutingDecision {
  const matchPath = options?.matchFilePathOverride ?? filePath;
  const inputLookupPath = options?.inputLookupPath ?? matchPath;
  const fileName = basename(matchPath);
  const lookupUsedSourceName = fileName;

  const inputLookupFull = resolve(inputLookupPath);
  const fromInput = config.inputs.find((input) => resolve(input.path) === inputLookupFull)?.mode;
  if (fromInput) {
    return withRoutingMeta(
      buildDecision(fromInput, 'input_mode', `config.inputs[].mode で ${fromInput} を指定`, columns),
      lookupUsedSourceName,
      'input_mode',
    );
  }

  for (const [pattern, rule] of Object.entries(config.diffKeys ?? {})) {
    if (globMatch(pattern, fileName) && rule.mode) {
      return withRoutingMeta(
        buildDecision(rule.mode, 'diff_key_mode', `diffKeys.${pattern}.mode で ${rule.mode} を指定`, columns),
        lookupUsedSourceName,
        'diff_key_mode',
      );
    }
  }

  loadProfiles(config.outputDir);
  const profileMatch = matchProfile(fileName, columns, {
    isHeaderless: options?.isHeaderless ?? false,
    columnCount: columns.length,
  });
  const matchedProfile = profileMatch.profile;
  const childColumns = childColumnNames(columns);
  const hasCustomerSignals = columns.some((col) => CUSTOMER_SIGNAL_PATTERNS.some((pattern) => pattern.test(col)));
  const inferredCustomerLike = matchedProfile?.id === 'customer-list' || (hasCustomerSignals && /顧客/i.test(fileName));
  const mixedParentChildExport = inferredCustomerLike && childColumns.length > 0;

  if (inferredCustomerLike) {
    const childNote = mixedParentChildExport
      ? `。FileMaker 親子混在 export の疑いあり (${childColumns.length} child columns)`
      : '';
    return withRoutingMeta(
      buildDecision(
        'mainline',
        'profile_inference',
        `customer-list 系として mainline 推定${childNote}`,
        columns,
        {
          matchedProfileId: matchedProfile?.id ?? 'customer-list',
          matchedProfileLabel: matchedProfile?.label ?? '顧客一覧',
          matchedProfileConfidence: profileMatch.confidence,
          mixedParentChildExport,
          recommendedRecordFamily: 'customer_master_like',
        },
      ),
      lookupUsedSourceName,
      'profile_inference',
    );
  }

  return withRoutingMeta(
    buildDecision('archive', 'default_archive', '明示的な mainline 根拠がないため archive を維持', columns, {
      matchedProfileId: matchedProfile?.id,
      matchedProfileLabel: matchedProfile?.label,
      matchedProfileConfidence: profileMatch.confidence,
    }),
    lookupUsedSourceName,
    'default_archive',
  );
}
