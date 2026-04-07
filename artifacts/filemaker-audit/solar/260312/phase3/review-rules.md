# Review Rules — Solar 260312 Phase 3

## activity-call-match-review-queue

| review_reason | severity | 条件 | 対処方針 |
|---------------|----------|------|----------|
| multi_match | high | 電話番号が2件以上の顧客にマッチ | 現場確認。内容・日付から正しい顧客を特定 |
| no_match | medium | 有効な電話番号だが顧客マスタに該当なし | 新規顧客か、電話番号変更か確認 |
| invalid | low | 電話番号として不正（桁数不足、非電話文字列） | データ品質問題。原本確認 |
| weak_overlap | low | Source A/B 間で日付+担当者が一致するが内容が異なる | 情報提供。dedupe 判断に使用 |

## customer-deal-boundary-review-queue

各行の `action` フィールドを確認:
- **keep**: 現在の分類を維持。根拠が明確
- **move**: 別 entity への移動を推奨。次期 schema で反映
- **review**: 業務ヒアリングが必要

## status-dictionary-candidate

`stage_confidence` が low の項目は業務ヒアリング必須。
`requires_hearing` 列に確認すべき内容を記載。
