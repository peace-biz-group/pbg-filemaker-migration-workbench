# Staging Schema v0 — Solar 260312

> **注意**: この schema は草案 (v0) です。DDL 実行・DB 投入はしません。
> Phase 1/2 の分析結果に基づく提案であり、業務ヒアリング未了の項目を含みます。

## 概要

| Entity | 推定行数 | ソース |
|--------|---------|--------|
| customer | 5,357 | 260312_顧客_太陽光.csv |
| deal | 5,357 | 260312_顧客_太陽光.csv |
| activity_call | 97,722 | 260312_コール履歴_太陽光.xlsx, 260312_顧客_太陽光.csv |

---

## customer

顧客基本情報。マスタ行（お客様IDあり）から抽出。

| column_name | proposed_type | nullable | source_column | normalization_rule | review | note |
|-------------|---------------|----------|---------------|-------------------|--------|------|
| customer_id | TEXT | NO | お客様ID | trim |  | PK。FileMaker のお客様ID |
| furigana | TEXT | YES | ﾌﾘｶﾞﾅ | halfWidthKanaToFullWidth + trim |  |  |
| address | TEXT | YES | 住所 | fullWidthToHalfWidth + trim |  |  |
| postal_code | TEXT | YES | 郵便番号 | trim, ###-#### format |  |  |
| phone | TEXT | YES | 電話番号 | normalizePhone |  |  |
| phone_search | TEXT | YES | 電番【検索用】 | normalizePhone |  | 電話番号のハイフンなし検索用。Phase 2 まで deal 分類だったが customer に移動 |
| fax | TEXT | YES | FAX番号 | normalizePhone |  |  |
| email | TEXT | YES | メールアドレス | trim + lowercase |  |  |
| representative_furigana | TEXT | YES | 代表者ﾌﾘｶﾞﾅ | halfWidthKanaToFullWidth + trim | YES | 法人顧客の代表者か個人の別名か要確認 |
| representative_mobile | TEXT | YES | 代表者携帯 | normalizePhone |  |  |
| representative_birthday | DATE | YES | 代表者生年月日 | normalizeDate (Excel serial → YYYY-MM-DD) |  | XLSX では Excel serial number |
| contact_furigana | TEXT | YES | 担当者ﾌﾘｶﾞﾅ | halfWidthKanaToFullWidth + trim |  |  |
| contact_mobile | TEXT | YES | 担当者携帯 | normalizePhone |  |  |
| emergency_contact | TEXT | YES | 緊急連絡先 | trim |  |  |
| occupation | TEXT | YES | 職業 | trim |  |  |
| industry_subclass | TEXT | YES | 業種【小分類】 | trim |  |  |
| fm_password | TEXT | YES | パスワード | none (legacy) |  | FileMaker レガシーフィールド |
| fm_username | TEXT | YES | ユーザー名 | none (legacy) |  | FileMaker レガシーフィールド |
| invoice_registration | TEXT | YES | インボイス | trim |  |  |
| application_id | TEXT | YES | 申請ID | trim |  |  |
| contact_info | TEXT | YES | 連絡先 | trim |  |  |
| preferred_contact_time | TEXT | YES | 連絡時間 | trim |  |  |
| raw_source_file | TEXT | NO |  |  |  | traceability: 元ファイル名 |
| raw_row_origin | INTEGER | NO |  |  |  | traceability: 元ファイルの行番号 |
| source_fingerprint | TEXT | NO |  |  |  | traceability: file:row_N 形式 |

## deal

案件・契約情報。マスタ行から抽出。customer と 1:1 の可能性が高いが未確定。

| column_name | proposed_type | nullable | source_column | normalization_rule | review | note |
|-------------|---------------|----------|---------------|-------------------|--------|------|
| customer_id | TEXT | NO | お客様ID | trim |  | FK → customer.customer_id |
| status | TEXT | YES | ステータス | trim |  | 16 種。status-dictionary-candidate.csv 参照 |
| cancel_flag | TEXT | YES | ｷｬﾝｾﾙﾌﾗｸﾞ | trim |  |  |
| cancel_date | DATE | YES | ｷｬﾝｾﾙ日 | normalizeDate |  |  |
| cancel_reason | TEXT | YES | キャンセル理由 | trim |  |  |
| estimate_maker | TEXT | YES | 【見積】メーカー | trim |  |  |
| estimate_request_date | DATE | YES | 【見積】依頼日 | normalizeDate |  |  |
| estimate_arrival_date | DATE | YES | 【見積】到着日 | normalizeDate |  |  |
| estimate_note | TEXT | YES | 【見積】備考 | trim |  |  |
| fit_approval_date | DATE | YES | FIT許可日 | normalizeDate |  |  |
| fit_application_date | DATE | YES | FIT申請依頼日 | normalizeDate |  |  |
| maker | TEXT | YES | メーカー | trim |  |  |
| module | TEXT | YES | モジュール | trim |  |  |
| installed_kw | NUMERIC(10,3) | YES | 設置kw | to_number |  |  |
| installation_store | TEXT | YES | 設置店名 | trim | YES | 設置店は entity 化候補。現状は deal に保持 |
| installation_address | TEXT | YES | 設置住所 | trim |  |  |
| installation_phone | TEXT | YES | 設置電話番号 | normalizePhone |  |  |
| installation_fax | TEXT | YES | 設置FAX番号 | normalizePhone |  |  |
| building_age | INTEGER | YES | 築年数 | to_integer |  |  |
| order_date | DATE | YES | 受注日 | normalizeDate |  |  |
| estimate_request_date_2 | DATE | YES | 見積依頼日 | normalizeDate |  | 【見積】依頼日 との重複要確認 |
| estimate_arrival_date_2 | DATE | YES | 見積到着日 | normalizeDate |  | 【見積】到着日 との重複要確認 |
| site_survey_date | DATE | YES | 業者現地調査日 | normalizeDate |  |  |
| applicant | TEXT | YES | 申込者 | trim | YES | 契約者と別人の場合あり。関係性要確認 |
| application_send_date | DATE | YES | 申込書発送日 | normalizeDate |  |  |
| lease_certificate_send | DATE | YES | 借受証発送 | normalizeDate |  |  |
| consent_send | DATE | YES | 承諾書発送 | normalizeDate |  |  |
| contractor | TEXT | YES | 契約者 | trim | YES | 顧客と別人の場合あり（家族名義等）。customer 移動は見送り |
| contractor_relationship | TEXT | YES | 契約者との続柄 | trim |  | 14 unique values |
| user_relationship | TEXT | YES | 使用者との続柄 | trim |  |  |
| monthly_amount | NUMERIC(15,2) | YES | 月額 | to_number |  |  |
| lease_fee | NUMERIC(15,2) | YES | リース料金 | to_number |  |  |
| credit_company | TEXT | YES | 信販会社 | trim |  |  |
| credit_request_date | DATE | YES | 審査依頼日 | normalizeDate |  |  |
| credit_result | TEXT | YES | 審査結果 | trim |  | 5 unique values |
| credit_result_date | DATE | YES | 審査結果日 | normalizeDate |  |  |
| credit_company_2 | TEXT | YES | 審査信販 | trim |  |  |
| power_application_date | DATE | YES | 電力申請依頼日 | normalizeDate |  |  |
| power_approval_date | DATE | YES | 電力申請許可日 | normalizeDate |  |  |
| drone_survey_date | DATE | YES | ドローン現調日 | normalizeDate |  |  |
| construction_request | TEXT | YES | 工事希望 | trim |  |  |
| construction_request_2 | TEXT | YES | 工事希望1 | trim |  |  |
| construction_date | DATE | YES | 工事日 | normalizeDate |  |  |
| construction_complete_date | DATE | YES | 工事完了日 | normalizeDate |  |  |
| revisit_date | DATE | YES | 再訪日 | normalizeDate |  |  |
| completion_report | DATE | YES | 完工報告 | normalizeDate |  |  |
| confirmation_complete_date | DATE | YES | 確認完了日 | normalizeDate |  |  |
| report_arrival_date | DATE | YES | 報告書到着日 | normalizeDate |  |  |
| floor_plan_arrival | DATE | YES | 平面図到着 | normalizeDate |  |  |
| warranty_application | DATE | YES | 保証申請 | normalizeDate |  |  |
| warranty_arrival | DATE | YES | 保証書着 | normalizeDate |  |  |
| disaster_insurance_application | DATE | YES | 災害補償申請 | normalizeDate |  |  |
| disaster_insurance_arrival | DATE | YES | 災害補償申請到着 | normalizeDate |  |  |
| invoice_date | DATE | YES | 請求書発行日 | normalizeDate |  |  |
| invoice_date_2 | DATE | YES | 請求書発行日② | normalizeDate |  |  |
| payment_date | DATE | YES | 入金日 | normalizeDate |  |  |
| payment_date_2 | DATE | YES | 入金日② | normalizeDate |  |  |
| delivery_date | DATE | YES | 納入日 | normalizeDate |  |  |
| order_placement_date | DATE | YES | 発注日 | normalizeDate |  |  |
| accounting_month | TEXT | YES | 成績計上月 | trim (YYMM/YYYYMM) |  | period 型。YYMM 形式 |
| accounting_date | DATE | YES | 成績計上日 | normalizeDate |  |  |
| gross_profit | NUMERIC(15,2) | YES | 計上粗利 | to_number |  |  |
| service_item_count | INTEGER | YES | ｻｰﾋﾞｽ品数 | to_integer |  |  |
| service_item_price | NUMERIC(15,2) | YES | ｻｰﾋﾞｽ品単価 | to_number |  |  |
| service_item_cost | NUMERIC(15,2) | YES | ｻｰﾋﾞｽ品原価 | to_number |  |  |
| service_item_delivery | DATE | YES | ｻｰﾋﾞｽ品納品 | normalizeDate |  |  |
| material | TEXT | YES | 部材 | trim |  |  |
| material_count | INTEGER | YES | 部材数 | to_integer |  |  |
| material_unit_price | NUMERIC(15,2) | YES | 部材単価【計上】 | to_number |  |  |
| material_cost | NUMERIC(15,2) | YES | 部材原価【計上】 | to_number |  |  |
| material_name | TEXT | YES | 部材名 | trim |  |  |
| construction_management | TEXT | YES | 施工管理 | trim |  | 5 unique values |
| sales_channel | TEXT | YES | 商流 | trim | YES | 販売ルート。entity 化候補 |
| sales_store | TEXT | YES | 販売店 | trim | YES | 販売代理店。entity 化候補 |
| slip_number | TEXT | YES | 伝票番号 | trim |  |  |
| additional_construction | TEXT | YES | 追加工事 | trim |  |  |
| required_documents | TEXT | YES | 必要書類 | trim |  |  |
| required_documents_date | DATE | YES | 必要書類　着日 | normalizeDate |  |  |
| note | TEXT | YES | 備考 | trim |  |  |
| caution | TEXT | YES | 注意事項 | trim |  |  |
| sheet_count | INTEGER | YES | 枚数 | to_integer |  | パネル枚数 |
| mail_date | DATE | YES | 郵送日 | normalizeDate |  |  |
| grid_connection_date | DATE | YES | 連系日 | normalizeDate |  |  |
| appointment_staff | TEXT | YES | ｱﾎﾟ担当 | trim |  |  |
| sales_staff | TEXT | YES | 営業担当 | trim |  |  |
| sales_comment | TEXT | YES | 営業コメント | trim |  |  |
| visit_count | INTEGER | YES | 回数 | to_integer |  |  |
| visit_staff | TEXT | YES | 訪問担当者 | trim |  |  |
| raw_source_file | TEXT | NO |  |  |  | traceability |
| raw_row_origin | INTEGER | NO |  |  |  | traceability |
| source_fingerprint | TEXT | NO |  |  |  | traceability |

## activity_call

コール履歴。Source A (独立コール履歴 XLSX) と Source B (顧客ファイル内ポータル展開) の2系統。

| column_name | proposed_type | nullable | source_column | normalization_rule | review | note |
|-------------|---------------|----------|---------------|-------------------|--------|------|
| source_kind | TEXT | NO |  |  |  | "source_a" (独立) or "source_b" (ポータル) |
| call_date | DATE | YES | 日付 / ｺｰﾙ履歴::日付 | normalizeDate |  |  |
| call_time | TIME | YES | 時刻 / ｺｰﾙ履歴::時刻 | excelSerialToTime |  |  |
| call_staff | TEXT | YES | 担当者 / ｺｰﾙ履歴::担当者 | fullWidthToHalfWidth + trim |  |  |
| content | TEXT | YES | 内容 / ｺｰﾙ履歴::内容 | trim |  |  |
| customer_staff | TEXT | YES | お客様担当 / ｺｰﾙ履歴::お客様担当 | trim |  |  |
| raw_phone | TEXT | YES | 電話番号【検索】 | none |  | Source A のみ。元の電話番号 |
| normalized_phone | TEXT | YES |  | normalizePhone |  | Source A: 電話番号【検索】、Source B: _fill_forward_電話番号 |
| matched_customer_id | TEXT | YES |  |  |  | 電話番号マッチで特定された customer_id (1件のみ) |
| matched_customer_candidate_count | INTEGER | YES |  |  |  | マッチ候補数 (0=no_match, 1=single, 2+=multi_match) |
| match_type | TEXT | YES |  |  |  | exact / normalized / no_match / multi_match / invalid / fill_forward |
| fill_forward_customer_id | TEXT | YES | _fill_forward_お客様ID |  |  | Source B のみ。ポータル展開の fill-forward ID |
| raw_source_file | TEXT | NO |  |  |  | traceability |
| raw_row_origin | INTEGER | NO |  |  |  | traceability |
| source_fingerprint | TEXT | NO |  |  |  | traceability |

---

## Customer / Deal 境界レビュー

| source_column | current | recommended | confidence | action | rationale |
|---------------|---------|-------------|------------|--------|-----------|
| 契約者 | deal | deal | high | keep | 契約者は案件ごとに異なりうる（家族名義等）。契約者との続柄が存在し deal 単位の属性。customer に移すと 1:N 案件時に破綻 |
| 申込者 | deal | deal | high | keep | 申込は案件単位の行為。同じ顧客が別案件で別人が申し込む可能性あり |
| 設置店名 | deal | deal | medium | keep | 設置店は案件ごとに異なる。将来的に entity 化（店舗マスタ）候補だが、現段階では deal に保持 |
| 販売店 | deal | deal | medium | keep | 販売代理店は案件ごとに異なる。設置店名と同様、entity 化候補だが現段階は deal に保持 |
| 商流 | deal | deal | high | keep | 販売ルート/チャネルは案件単位。同一顧客の別案件で商流が異なる可能性あり |
| ステータス | deal | deal | high | keep | 完了/キャンセル/対応中 等は明確に案件ライフサイクルの状態。顧客属性ではない |
| 審査依頼日 | deal | deal | high | keep | 信販審査は案件ごとのファイナンス手続き。審査結果・審査信販も同様 |
| 審査結果 | deal | deal | high | keep | 信販審査結果は案件単位。可決/否決/審査不可 等 |
| 工事日 | deal | deal | high | keep | 工事スケジュールは案件（太陽光設置）ごと。工事完了日、完工報告も同様 |
| 入金日 | deal | deal | high | keep | 入金は案件の支払い。入金日② は分割払い2回目と推定 |
| 電番【検索用】 | deal (Phase 2) | customer | high | move | 電話番号のハイフンなし正規化版。fill rate 10.1% = マスタ行のみ。customer.phone の検索用バリアント |
| ｱﾎﾟ担当 | deal | deal | medium | keep | アポイント担当者は案件の営業プロセスに属する。将来的に activity 分離候補だが現状は deal に保持 |
| 営業担当 | deal | deal | medium | keep | 営業担当は案件割り当て。顧客に紐づく場合もあるが、案件ごとに変わりうる |
| 契約者との続柄 | deal | deal | high | keep | 契約者が deal に属するため、その続柄も deal。14 unique values |
| 使用者との続柄 | deal | deal | medium | keep | 設置場所の使用者との関係。deal（設置案件）単位の情報 |

---

## 未確定事項

1. customer と deal の 1:1 / 1:N 関係は未確定。現データでは 1:1 に見えるが断定不可
2. activity_call の Source A / Source B は partial_overlap (11% 厳密一致)。hard dedupe は行わない
3. 「契約者」と顧客の関係性 — 同一人物の場合と家族名義の場合がある
4. 「代表者」系列 — 法人顧客の代表者か個人の別名か未確認
5. 見積依頼日 vs 【見積】依頼日 — 同一値か別フローか未確認
6. ステータス値のうち「連変」「取り直し」の業務的意味が不明
