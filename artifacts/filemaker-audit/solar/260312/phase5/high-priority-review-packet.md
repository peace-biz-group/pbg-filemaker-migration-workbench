# High Priority Review Packet — Solar 260312

> このパケットは、activity_call の電話番号マッチで high priority と判定された
> レビュー項目をまとめたものです。現場で1件ずつ確認してください。

生成日: 2026-04-07

---

## 概要

| 項目 | 値 |
|------|-----|
| 対象コール行数 | 462 件 |
| レビュー項目数（電話番号別） | 29 件 |
| review_bucket 内訳 | unclear: 16, same_name_same_phone: 7, same_phone_different_name: 6 |

## レビューの進め方

1. **CSV を開く**: `high-priority-review-packet.csv` を Excel / Google Sheets で開く
2. **1行ずつ確認**: candidate_names と candidate_addresses を見て、content_preview と照合
3. **判断を記入**: 以下の3列を埋める
   - `human_decision`: `resolved` / `skip` / `unclear`
   - `chosen_customer_id`: 正しい顧客 ID (例: RC0L001)
   - `reviewer_note`: 判断理由のメモ
4. **保存して返送**: 記入済み CSV を保存

## review_bucket の説明

| Bucket | 件数 | 意味 | 対処のヒント |
|--------|------|------|-------------|
| unclear | 16 | 候補顧客の住所・名前からパターンが読み取れない | content_preview を読んで判断 |
| same_name_same_phone | 7 | 同じ名前・同じ電話番号で複数 ID がある | 重複登録の可能性。住所を比較して同一か判断 |
| same_phone_different_name | 6 | 同じ電話番号だが名前が違う | 家族・同僚の可能性。コール内容から対象者を特定 |

## 判断に迷ったら

- `human_decision` に `unclear` と書いて飛ばしてください
- 後でまとめて確認します
- 無理に決めないでください

---

## レビュー項目一覧 (先頭 20 件)

| # | review_id | 電話番号 | 候補数 | コール数 | bucket | 候補顧客 |
|---|-----------|---------|--------|---------|--------|---------|
| 1 | HR-0001 | 0929802702 | 2 | 19 | unclear | RC0L001: ｶﾜｸﾞﾁﾋﾃﾞｷ | RC2K057: ｲｿｶﾞｲｺｳﾀﾛｳ(ｵｰﾙﾃﾞﾝｶ) |
| 2 | HR-0002 | 0947820455 | 2 | 2 | same_name_same_phone | RC1J005: ｵｵﾀﾆｱｷﾉﾘ | RC3E051: ｵｵﾀﾆｱｷﾉﾘ |
| 3 | HR-0003 | 0947441344 | 2 | 17 | unclear | RC2A004: ｼﾗｲｼﾊﾂﾐ | RC4J016: ｼﾗｲｼﾅｵﾏｻ(ﾁｸﾃﾞﾝﾁ) |
| 4 | HR-0004 | 09083965898 | 2 | 5 | unclear | RC2F083: ﾕｷﾀｹｶｽﾞﾋﾛ | RC3C052: ﾕｸﾀｹｶｽﾞﾋﾛ |
| 5 | HR-0005 | 0297353105 | 2 | 16 | unclear | RC2F078: ｲﾄｳﾀｹﾋｺ | RC2F079: ﾅｶﾑﾗﾋﾛｼ |
| 6 | HR-0006 | 09022096872 | 2 | 11 | unclear | RC2G015: ｶﾌﾞｼｷｶﾞｲｼｬｵｵﾅﾐ | RC2G016: ｸﾗﾓﾁﾏｽﾐ2 |
| 7 | HR-0007 | 0227910880 | 2 | 1 | same_phone_different_name | RC2I047: ﾔﾏｶﾜｶｽﾞﾄｼﾃﾝﾎﾟ | RC2I048: ﾔﾏｶﾜｶｽﾞﾄｼｼﾞﾀｸ |
| 8 | HR-0008 | 0929266273 | 2 | 12 | same_name_same_phone | RC2K068: ｻｸﾗﾀﾞｼﾝ | RC3B062: ｻｸﾗﾀﾞｼﾝ |
| 9 | HR-0009 | 0946520561 | 2 | 7 | unclear | RC3C116: ｻﾞｲﾂｶｽﾞﾔ | RC3C117: ｻﾞｲﾂﾖｼﾕｷ |
| 10 | HR-0010 | 0832580230 | 2 | 55 | unclear | RC3F052: ｼﾐｽﾞｷﾖﾊﾙ | RC3I096: ﾜﾀﾅﾍﾞｶｽﾞﾋｺ |
| 11 | HR-0011 | 08030566746 | 2 | 59 | same_phone_different_name | RC3F123: ｸﾎﾞﾀｼﾝﾔ | RC3H004: ｸﾎﾞﾀｷｲﾁ |
| 12 | HR-0012 | 09044804125 | 2 | 4 | same_phone_different_name | RC3F050: ﾀﾅｶﾄﾓｶｽﾞ | RC5G070: ﾀﾅｶﾄﾓｶｽﾞ |
| 13 | HR-0013 | 0224842705 | 2 | 6 | same_name_same_phone | RC3E060: ｵｲｷｻﾌﾞﾛｳ | RC4I077: ｵｲｷｻﾌﾞﾛｳ |
| 14 | HR-0014 | 0225829823 | 2 | 10 | same_phone_different_name | RC3H002: ｶﾌﾞｼｷｶﾞｲｼｬｴﾑｱｰﾙﾃｯｸ(ｼﾞﾀｸ） | RC3H003: ｶﾌﾞｼｷｶﾞｲｼｬｴﾑｱｰﾙ |
| 15 | HR-0015 | 0297836636 | 2 | 3 | same_name_same_phone | RC3Ｇ119: ﾅｶﾔﾏｺｳｲﾁ | RC4B016: ﾅｶﾔﾏｺｳｲﾁ |
| 16 | HR-0016 | 0944226517 | 2 | 8 | same_name_same_phone | RC3H123: ｵｷﾂﾋﾛﾐ | RC3H124: ｵｷﾂﾋﾛﾐ |
| 17 | HR-0017 | 0229634520 | 2 | 15 | unclear | RC3I060: ﾕｳｹﾞﾝｶﾞｲｼｬｱｻﾉｲﾝﾃﾘｱｸﾘｰﾆﾝｸﾞ(ｼﾞﾑｼｮ) | RC3I061: ﾕｳｹﾞﾝｶﾞ |
| 18 | HR-0018 | 09037114292 | 2 | 8 | same_phone_different_name | RC3I081: ｵｵﾀｼﾞｭﾝ | RC3I090: ｳﾗﾓﾄﾕｳﾀﾛｳ |
| 19 | HR-0019 | 09067755843 | 2 | 7 | same_phone_different_name | RC3K011: ﾑﾀﾔｽﾉﾘ(ﾑｽｺｻﾏﾀｸ) | RC3K018: ﾑﾀﾔｽﾉﾘ(ｵｶｱｻﾏﾀｸ) |
| 20 | HR-0020 | 0944622009 | 2 | 7 | same_name_same_phone | RC3K063: ｳｴﾀﾞﾔｽﾉﾘ | RC3K064: ｳｴﾀﾞﾔｽﾉﾘ |

> 残り 9 件は CSV ファイルを参照してください。
