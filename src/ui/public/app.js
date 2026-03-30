/**
 * FileMaker Data Workbench — Review UI (vanilla JS SPA)
 * Client-side routing via path, served by Express catch-all.
 */

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

// --- Labels cache ---
let labels = {};
async function loadLabels() {
  try {
    labels = await api('/api/labels');
  } catch { /* use empty fallback */ }
}
function label(dict, key) {
  return (labels[dict] && labels[dict][key]) || key;
}

// --- Router ---

function navigate(path) {
  history.pushState(null, '', path);
  route();
}

window.addEventListener('popstate', route);

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a && a.getAttribute('href').startsWith('/') && !a.getAttribute('href').startsWith('/api')) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }
});

function route() {
  const path = location.pathname;
  if (path === '/new') return renderNewRun();
  const runMatch = path.match(/^\/runs\/(.+)$/);
  if (runMatch) return renderRunDetail(runMatch[1]);
  return renderDashboard();
}

// --- API helpers ---

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// --- Dashboard ---

async function renderDashboard() {
  app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">ダッシュボード</h2>
      <a href="/new" class="btn btn-primary">新規 Run</a>
    </div>
    <div class="card" id="run-list-card">
      <h3>直近の実行結果</h3>
      <div class="loading">読み込み中...</div>
    </div>
  `;

  try {
    const runs = await api('/api/runs');
    const container = $('#run-list-card');

    if (runs.length === 0) {
      container.innerHTML = `
        <div class="empty">
          <p>まだ実行結果がありません</p>
          <a href="/new" class="btn btn-primary" style="margin-top:12px">最初の Run を作成</a>
        </div>
      `;
      return;
    }

    let html = '<div class="run-list">';
    for (const run of runs) {
      const status = run.status === 'completed'
        ? '<span class="badge badge-success">完了</span>'
        : run.status === 'failed'
          ? '<span class="badge badge-danger">失敗</span>'
          : '<span class="badge badge-warning">実行中</span>';
      const time = new Date(run.startedAt).toLocaleString('ja-JP');
      const files = run.inputFiles.map(f => f.split('/').pop()).join(', ');
      html += `
        <a href="/runs/${run.id}" class="run-item">
          <span class="run-mode">${run.mode}</span>
          ${status}
          <span class="run-files" title="${run.inputFiles.join(', ')}">${files}</span>
          <span class="run-time">${time}</span>
        </a>
      `;
    }
    html += '</div>';
    container.innerHTML = `<h3>直近の実行結果 (${runs.length}件)</h3>` + html;
  } catch (err) {
    $('#run-list-card').innerHTML = `<p class="empty">読み込みに失敗しました: ${err.message}</p>`;
  }
}

// --- New Run ---

let uploadedFiles = [];

async function renderNewRun() {
  uploadedFiles = [];
  let configs = [];
  try { configs = await api('/api/configs'); } catch { /* ignore */ }

  const configOptions = configs.map(c => `<option value="${c}">${c}</option>`).join('');

  app.innerHTML = `
    <h2 style="font-size:18px;margin-bottom:16px">新規 Run</h2>
    <div class="card">
      <form id="run-form">
        <div class="form-group">
          <label>実行モード</label>
          <select name="mode" required>
            <option value="run-all">run-all（単一ファイル全パイプライン）</option>
            <option value="run-batch">run-batch（複数ファイル横断）</option>
            <option value="profile">profile（データプロファイルのみ）</option>
            <option value="normalize">normalize（正規化のみ）</option>
            <option value="detect-duplicates">detect-duplicates（重複検出のみ）</option>
            <option value="classify">classify（分類のみ）</option>
          </select>
        </div>

        <div class="form-group">
          <label>設定ファイル（任意）</label>
          <select name="configPath">
            <option value="">デフォルト設定</option>
            ${configOptions}
          </select>
        </div>

        <div class="form-group">
          <label>文字コード (encoding)</label>
          <select name="encoding">
            <option value="auto">自動検出</option>
            <option value="utf8">UTF-8</option>
            <option value="cp932" selected>Shift-JIS (CP932)</option>
          </select>
        </div>
        <div class="form-group">
          <label>区切り文字 (delimiter)</label>
          <select name="delimiter">
            <option value="auto">自動検出</option>
            <option value=",">カンマ (,)</option>
            <option value="\t">タブ (\\t)</option>
            <option value=";">セミコロン (;)</option>
          </select>
        </div>
        <div class="form-group">
          <label><input type="checkbox" name="hasHeader" checked> ヘッダ行あり</label>
        </div>

        <div class="form-group">
          <label>入力ファイル — ドラッグ＆ドロップまたはクリックでアップロード</label>
          <div class="drop-zone" id="drop-zone">
            <p>CSV / XLSX ファイルをここにドロップ<br>またはクリックしてファイルを選択</p>
            <input type="file" id="file-input" multiple accept=".csv,.xlsx" style="display:none">
            <div class="file-list-preview" id="file-preview"></div>
          </div>
        </div>

        <div class="form-group">
          <label>または、ローカルパスを直接指定</label>
          <textarea name="filePaths" placeholder="1行に1ファイルパスを入力&#10;例:&#10;/Users/you/data/apo_list_2024.csv" rows="3"></textarea>
          <p style="font-size:11px;color:var(--text-secondary);margin-top:4px">
            サーバーが読み取れるローカルファイルの絶対パスまたは相対パスを指定してください
          </p>
        </div>

        <div id="progress-area" style="display:none">
          <div class="progress-container">
            <div class="progress-bar-wrap"><div class="progress-bar-fill" id="progress-fill"></div></div>
            <div class="progress-step" id="progress-text"></div>
          </div>
        </div>

        <div style="display:flex;gap:8px;align-items:center">
          <button type="submit" class="btn btn-primary" id="run-submit">実行</button>
          <button type="button" class="btn" id="preview-btn">Preview</button>
          <span id="run-status" style="font-size:13px;color:var(--text-secondary)"></span>
        </div>
      </form>
    </div>
  `;

  // Drop zone setup
  const dropZone = $('#drop-zone');
  const fileInput = $('#file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  // Form submit
  $('#run-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('#run-submit');
    const status = $('#run-status');

    btn.disabled = true;
    status.textContent = '実行中...';
    status.style.color = 'var(--text-secondary)';

    try {
      const mode = form.mode.value;
      const configPath = form.configPath.value;
      const filePathsText = form.filePaths.value.split('\n').map(s => s.trim()).filter(Boolean);

      if (uploadedFiles.length === 0 && filePathsText.length === 0) {
        throw new Error('入力ファイルを指定してください');
      }

      const ingestOptions = {
        encoding: form.encoding.value,
        delimiter: form.delimiter.value,
        hasHeader: form.hasHeader.checked,
      };

      let result;
      if (uploadedFiles.length > 0) {
        // Use multipart upload
        const formData = new FormData();
        formData.append('mode', mode);
        if (configPath) formData.append('configPath', configPath);
        for (const f of uploadedFiles) {
          formData.append('files', f);
        }
        if (filePathsText.length > 0) {
          formData.append('filePaths', JSON.stringify(filePathsText));
        }
        formData.append('ingestOptions', JSON.stringify(ingestOptions));
        const res = await fetch('/api/runs', { method: 'POST', body: formData });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        result = await res.json();
      } else {
        result = await api('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, configPath, filePaths: filePathsText, ingestOptions }),
        });
      }

      navigate(`/runs/${result.id}`);
    } catch (err) {
      status.textContent = `エラー: ${err.message}`;
      status.style.color = 'var(--danger)';
      btn.disabled = false;
    }
  });

  // Preview button handler
  const previewBtn = $('#preview-btn');
  if (previewBtn) {
    previewBtn.addEventListener('click', async () => {
      const form = $('#run-form');
      const filePaths = form.filePaths.value.split('\n').map(s => s.trim()).filter(Boolean);
      if (filePaths.length === 0 && uploadedFiles.length === 0) {
        alert('ファイルを指定してください');
        return;
      }
      const file = filePaths[0] ?? '';
      if (!file) { alert('プレビューにはローカルパスを指定してください'); return; }
      const enc = form.encoding.value;
      const delim = form.delimiter.value;
      try {
        const data = await api(`/api/preview?file=${encodeURIComponent(file)}&encoding=${enc}&delimiter=${encodeURIComponent(delim)}`);
        // Large file guidance
        const totalRows = (data.diagnosis && data.diagnosis.totalRowsRead) || 0;
        const fileSize = data.fileSize || 0;
        const isLargeFile = totalRows > 100000 || fileSize > 50 * 1024 * 1024;
        if (isLargeFile) {
          const rowsInMan = Math.round(totalRows / 10000);
          const guideEl = document.createElement('div');
          guideEl.className = 'large-file-guide';
          guideEl.innerHTML = `
            <p>このファイルは大きいです（${rowsInMan > 0 ? rowsInMan + '万行以上' : '50MB以上'}）。定義確認には先頭のサンプルで十分です。</p>
            <div class="btn-group">
              <button class="btn btn-primary" id="btn-sample-run">サンプルで定義を確認</button>
              <button class="btn" id="btn-full-run">全件で実行</button>
            </div>
          `;
          const statusEl = document.getElementById('run-status');
          if (statusEl) statusEl.parentElement.before(guideEl);
          document.getElementById('btn-sample-run')?.addEventListener('click', () => {
            guideEl.remove();
            const form = document.querySelector('#run-form');
            if (form) { form.mode.value = 'profile'; }
            alert('モードを「profile」に設定しました。実行してください。');
          });
          document.getElementById('btn-full-run')?.addEventListener('click', () => guideEl.remove());
        }
        showPreviewModal(data);
      } catch (err) {
        alert('Preview 失敗: ' + err.message);
      }
    });
  }
}

// --- Upload confirmation modal ---
// Called before run execution when files are selected to match against templates
async function showUploadConfirmModal(filename, columns, encoding, hasHeader, onConfirm) {
  let matches = [];
  try {
    matches = await api('/api/templates/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, columns, encoding: encoding || 'utf8', hasHeader: hasHeader !== false }),
    });
  } catch { /* ignore, show new-file option only */ }

  const existing = document.getElementById('upload-confirm-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'upload-confirm-modal';
  overlay.className = 'modal-overlay';

  // Build candidate cards HTML
  let cardsHtml = '';
  for (let i = 0; i < Math.min(matches.length, 3); i++) {
    const m = matches[i];
    const reasons = (m.reasons || []).map(r => escapeHtml(label('matchReasons', r.factor))).join('、');
    cardsHtml += `
      <div class="modal-candidate-card" data-idx="${i}">
        <div class="candidate-name">&#x25CB; ${escapeHtml(m.template.displayName)}</div>
        <div class="candidate-reasons">${reasons}</div>
      </div>
    `;
  }
  // New file option
  cardsHtml += `
    <div class="modal-candidate-card" data-idx="-1">
      <div class="candidate-name">&#x25CB; 新しい種類のファイルとして扱う</div>
      <div class="candidate-reasons">テンプレートを使わずに処理します</div>
    </div>
  `;

  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-title">このファイルは何ですか？</div>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
        ファイル名: ${escapeHtml(filename)}
      </p>
      <div id="candidate-list">${cardsHtml}</div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" id="confirm-modal-cancel">キャンセル</button>
        <button class="btn btn-primary" id="confirm-modal-ok">確定</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  let selectedIdx = matches.length > 0 ? 0 : -1; // default: first match or "new"

  function updateSelection() {
    overlay.querySelectorAll('.modal-candidate-card').forEach((card, i) => {
      const cardIdx = parseInt(card.dataset.idx);
      const isSelected = cardIdx === selectedIdx;
      card.classList.toggle('selected', isSelected);
      card.querySelector('.candidate-name').textContent = (isSelected ? '● ' : '○ ') +
        card.querySelector('.candidate-name').textContent.replace(/^[●○] /, '');
    });
  }

  // Auto-select first candidate
  updateSelection();

  overlay.querySelectorAll('.modal-candidate-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedIdx = parseInt(card.dataset.idx);
      updateSelection();
    });
  });

  document.getElementById('confirm-modal-cancel').addEventListener('click', () => overlay.remove());
  document.getElementById('confirm-modal-ok').addEventListener('click', () => {
    overlay.remove();
    const selectedTemplate = selectedIdx >= 0 ? matches[selectedIdx]?.template : null;
    onConfirm(selectedTemplate);
  });
}

function showPreviewModal(data) {
  // Remove existing modal
  const existing = document.getElementById('preview-modal');
  if (existing) existing.remove();

  const diag = data.diagnosis || {};
  const diagInfo = diag.format === 'csv'
    ? `エンコード: ${diag.detectedEncoding} (${diag.encodingConfidence}) → ${diag.appliedEncoding} | 区切り: ${diag.appliedDelimiter === '\t' ? 'タブ' : diag.appliedDelimiter}`
    : `形式: XLSX (${diag.sheetName || ''})`;

  const modal = document.createElement('div');
  modal.id = 'preview-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px';
  modal.innerHTML = `
    <div style="background:var(--surface);border-radius:8px;padding:24px;max-width:900px;width:100%;max-height:80vh;overflow:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:16px">Preview: ${escapeHtml(data.file.split('/').pop())}</h2>
        <button onclick="document.getElementById('preview-modal').remove()" class="btn">閉じる</button>
      </div>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">${escapeHtml(diagInfo)}</p>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
        カラム: ${(data.columns || []).length} |
        Schema FP: ${(data.schemaFingerprint || '').slice(0,16)}... |
        Parse エラー: ${data.parseFailures ? data.parseFailures.length : 0}
      </p>
      ${data.mappingSuggestions && data.mappingSuggestions.length > 0 ? `
        <div style="margin-bottom:12px;padding:8px;background:var(--surface-hover,#f5f5f5);border-radius:4px">
          <strong style="font-size:12px">マッピング候補:</strong>
          ${data.mappingSuggestions.map(s => `<span style="font-size:12px;margin-left:8px">${escapeHtml(s.sourceColumn)} → ${escapeHtml(label('semanticFields', s.suggestedCanonical))} (${s.confidence})</span>`).join('')}
        </div>
      ` : ''}
      ${renderMojibakeWarnings(data.mojibakeScan, (data.diagnosis || {}).appliedEncoding)}
      ${renderHeaderWarnings(data.headerDetection, (data.diagnosis || {}).headerApplied !== false)}
      ${data.sampleRows && data.sampleRows.length > 0 ? renderDataTable(data.columns, data.sampleRows) : '<p class="empty">データなし</p>'}
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Handle header toggle — re-fetch preview with new hasHeader
  const headerToggle = modal.querySelector('#toggle-has-header');
  if (headerToggle) {
    headerToggle.addEventListener('change', async () => {
      const form = document.querySelector('#run-form');
      if (!form) return;
      const file = form.filePaths?.value?.split('\n').map(s => s.trim()).filter(Boolean)[0];
      if (!file) return;
      const enc = form.encoding?.value || 'auto';
      const delim = form.delimiter?.value || 'auto';
      const hasHdr = headerToggle.checked;
      try {
        const newData = await api(`/api/preview?file=${encodeURIComponent(file)}&encoding=${enc}&delimiter=${encodeURIComponent(delim)}&hasHeader=${hasHdr}`);
        modal.remove();
        showPreviewModal(newData);
      } catch (err) {
        alert('プレビュー再取得失敗: ' + err.message);
      }
    });
  }
}

// --- Header detection warning rendering ---
function renderHeaderWarnings(headerDetection, currentHasHeader, onToggle) {
  if (!headerDetection) return '';
  const warnings = headerDetection.warnings || [];
  if (warnings.length === 0) return '';

  const warningHtml = warnings.map(w => `<p style="margin-bottom:4px">${escapeHtml(w)}</p>`).join('');
  return `
    <div class="warning-banner" id="header-warning">
      ${warningHtml}
      <div style="margin-top:8px">
        <label style="cursor:pointer">
          <input type="checkbox" id="toggle-has-header" ${currentHasHeader ? 'checked' : ''}>
          1行目を項目名として使う
        </label>
      </div>
    </div>
  `;
}

// --- Mojibake warning rendering ---
function renderMojibakeWarnings(mojibakeScan, encoding) {
  if (!mojibakeScan) return '';
  let html = '';
  if (mojibakeScan.mojibakeRatio > 0.3) {
    html += `<div class="danger-banner">${escapeHtml(mojibakeScan.warnings[0] || '文字化けが多いです。')}</div>`;
  } else if (mojibakeScan.hasMojibake) {
    html += `<div class="warning-banner">${escapeHtml(mojibakeScan.warnings[0] || '文字化けの可能性があります。')}</div>`;
  }
  if (mojibakeScan.hasControlChars) {
    const ctrlWarn = mojibakeScan.warnings.find(w => w.includes('制御文字')) || `制御文字が含まれています（${mojibakeScan.controlCharCount}箇所）`;
    html += `<div class="warning-banner">${escapeHtml(ctrlWarn)}</div>`;
  }
  return html;
}

function addFiles(fileList) {
  for (const f of fileList) {
    if (!uploadedFiles.some(u => u.name === f.name && u.size === f.size)) {
      uploadedFiles.push(f);
    }
  }
  renderFilePreview();
}

function renderFilePreview() {
  const container = $('#file-preview');
  if (!container) return;
  if (uploadedFiles.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = uploadedFiles.map((f, i) =>
    `<div>${escapeHtml(f.name)} (${formatSize(f.size)}) <span class="remove-file" data-idx="${i}">&times;</span></div>`
  ).join('');

  container.querySelectorAll('.remove-file').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      uploadedFiles.splice(parseInt(el.dataset.idx), 1);
      renderFilePreview();
    });
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// --- Run Detail ---

async function renderRunDetail(runId) {
  app.innerHTML = '<div class="loading">読み込み中...</div>';

  try {
    const [run, files] = await Promise.all([
      api(`/api/runs/${runId}`),
      api(`/api/runs/${runId}/files`),
    ]);

    const statusBadge = run.status === 'completed'
      ? '<span class="badge badge-success">完了</span>'
      : run.status === 'failed'
        ? '<span class="badge badge-danger">失敗</span>'
        : '<span class="badge badge-warning">実行中</span>';

    const summary = run.summary || {};
    const breakdown = summary.classificationBreakdown || {};
    const inputFiles = run.inputFiles.map(f => f.split('/').pop()).join(', ');

    // Determine available tabs from files
    const csvFiles = files.filter(f => f.endsWith('.csv'));
    const hasAnomalies = csvFiles.includes('anomalies.csv');
    const hasDuplicates = csvFiles.includes('duplicates.csv');
    const hasQuarantine = csvFiles.includes('quarantine.csv');
    const hasClassified = csvFiles.includes('classified.csv');
    const hasNormalized = csvFiles.includes('normalized.csv');
    const hasParseQuarantine = csvFiles.includes('parse-quarantine.csv');

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="font-size:18px">
          Run: ${run.mode} ${statusBadge}
        </h2>
        <div class="btn-group">
          <button class="btn" id="btn-rerun" title="同じ設定で再実行">再実行</button>
          <button class="btn btn-danger" id="btn-delete" title="この Run を削除">削除</button>
          <a href="/" class="btn">ダッシュボードに戻る</a>
        </div>
      </div>
    `;

    // Error display
    if (run.error) {
      html += `<div class="card" style="border-color:var(--danger)"><h3 style="color:var(--danger)">エラー</h3><p>${escapeHtml(run.error)}</p></div>`;
    }

    // Summary card
    html += `
      <div class="card">
        <h2>サマリ</h2>
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">
          実行日時: ${new Date(run.startedAt).toLocaleString('ja-JP')}
          ${run.completedAt ? ` — 完了: ${new Date(run.completedAt).toLocaleString('ja-JP')}` : ''}
          <br>対象ファイル: ${escapeHtml(inputFiles)}
        </p>
        <div class="stats">
          <div class="stat"><div class="label">レコード数</div><div class="value">${(summary.recordCount || 0).toLocaleString()}</div></div>
          <div class="stat"><div class="label">カラム数</div><div class="value">${summary.columnCount || 0}</div></div>
          <div class="stat"><div class="label">正規化済み</div><div class="value">${(summary.normalizedCount || 0).toLocaleString()}</div></div>
          <div class="stat"><div class="label">確認が必要</div><div class="value">${(summary.quarantineCount || 0).toLocaleString()}</div></div>
          <div class="stat"><div class="label">Parse エラー</div><div class="value">${(summary.parseFailCount || 0).toLocaleString()}</div></div>
          <div class="stat"><div class="label">重複グループ</div><div class="value">${(summary.duplicateGroupCount || 0).toLocaleString()}</div></div>
        </div>
        ${run.ingestDiagnoses && Object.keys(run.ingestDiagnoses).length > 0 ? `
          <div style="margin-top:8px;font-size:11px;color:var(--text-secondary)">
            ${Object.entries(run.ingestDiagnoses).map(([f, d]) => {
              const fname = f.split('/').pop();
              if (d.format === 'csv') {
                return `<span title="${escapeHtml(f)}">${escapeHtml(fname)}: ${d.detectedEncoding} (${d.encodingConfidence}) | ${d.appliedDelimiter === '\t' ? 'タブ' : d.appliedDelimiter}</span>`;
              }
              return `<span>${escapeHtml(fname)}: xlsx</span>`;
            }).join(' | ')}
          </div>
        ` : ''}
    `;

    // Classification breakdown
    if (Object.values(breakdown).some(v => v > 0)) {
      html += '<h3>分類内訳</h3><div class="stats">';
      for (const [type, count] of Object.entries(breakdown)) {
        html += `<div class="stat"><div class="label">${label('fileTypes', type)}</div><div class="value">${(count || 0).toLocaleString()}</div></div>`;
      }
      html += '</div>';
    }
    html += '</div>';

    // Tabs
    const tabs = [];
    if (hasNormalized) tabs.push({ id: 'compare', label: 'Before / After 比較', file: 'normalized.csv', special: 'compare' });
    if (hasNormalized) tabs.push({ id: 'normalized', label: '正規化データ', file: 'normalized.csv' });
    if (hasAnomalies) tabs.push({ id: 'anomalies', label: '異常値', file: 'anomalies.csv' });
    if (hasDuplicates) tabs.push({ id: 'duplicates', label: '重複候補', file: 'duplicates.csv', special: 'dup-groups' });
    if (hasQuarantine) tabs.push({ id: 'quarantine', label: 'Quarantine', file: 'quarantine.csv' });
    if (hasParseQuarantine) tabs.push({ id: 'parse-quarantine', label: 'Parse エラー', file: 'parse-quarantine.csv' });
    if (hasClassified) tabs.push({ id: 'classified', label: '分類結果', file: 'classified.csv' });

    if (tabs.length > 0) {
      html += '<div class="card"><h2>結果レビュー</h2>';
      html += '<div class="tabs">';
      for (let i = 0; i < tabs.length; i++) {
        html += `<div class="tab ${i === 0 ? 'active' : ''}" data-tab="${tabs[i].id}">${tabs[i].label}</div>`;
      }
      html += '</div>';
      for (let i = 0; i < tabs.length; i++) {
        html += `<div class="tab-content ${i === 0 ? 'active' : ''}" id="tab-${tabs[i].id}">
          <div class="loading" id="loading-${tabs[i].id}">読み込み中...</div>
        </div>`;
      }
      html += '</div>';
    }

    // Output files
    html += `
      <div class="card">
        <h2>出力ファイル</h2>
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">保存先: ${escapeHtml(run.outputDir)}</p>
        <ul class="file-list">
          ${files.map(f => `<li><a href="/api/runs/${runId}/raw/${f}" target="_blank">${f}</a></li>`).join('')}
        </ul>
      </div>
    `;

    app.innerHTML = html;

    // Delete button
    document.getElementById('btn-delete').addEventListener('click', async () => {
      if (!confirm('この Run を削除しますか？')) return;
      try {
        await api(`/api/runs/${runId}`, { method: 'DELETE' });
        navigate('/');
      } catch (err) {
        alert('削除に失敗しました: ' + err.message);
      }
    });

    // Rerun button
    document.getElementById('btn-rerun').addEventListener('click', async () => {
      if (!confirm('同じ設定で再実行しますか？')) return;
      try {
        const result = await api(`/api/runs/${runId}/rerun`, { method: 'POST' });
        navigate(`/runs/${result.id}`);
      } catch (err) {
        alert('再実行に失敗しました: ' + err.message);
      }
    });

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = document.getElementById('tab-' + tab.dataset.tab);
        if (target) target.classList.add('active');
      });
    });

    // Load first tab data
    if (tabs.length > 0) {
      loadTabContent(runId, tabs[0]);
      document.querySelectorAll('.tab').forEach(tabEl => {
        tabEl.addEventListener('click', () => {
          const tabDef = tabs.find(t => t.id === tabEl.dataset.tab);
          if (tabDef) loadTabContent(runId, tabDef);
        });
      });
    }

  } catch (err) {
    app.innerHTML = `<div class="card"><p class="empty">読み込みに失敗しました: ${err.message}</p></div>`;
  }
}

// --- Tab content loading ---

const loadedTabs = new Set();

async function loadTabContent(runId, tabDef) {
  if (loadedTabs.has(tabDef.id)) return;

  if (tabDef.special === 'compare') {
    await loadCompareView(runId, tabDef);
  } else if (tabDef.special === 'dup-groups') {
    await loadDuplicateGroups(runId, tabDef);
  } else {
    await loadTabData(runId, tabDef, 0);
  }
}

async function loadTabData(runId, tabDef, offset = 0) {
  const container = document.getElementById('tab-' + tabDef.id);
  if (!container) return;

  const limit = 100;

  try {
    const data = await api(`/api/runs/${runId}/data/${tabDef.file}?offset=${offset}&limit=${limit}`);
    loadedTabs.add(tabDef.id);

    if (data.rows.length === 0 && offset === 0) {
      container.innerHTML = '<p class="empty">データがありません</p>';
      return;
    }

    let html = `<p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">${data.totalCount.toLocaleString()} 件中 ${offset + 1}-${Math.min(offset + limit, data.totalCount)} 件を表示</p>`;
    html += renderDataTable(data.columns, data.rows);

    // Pagination
    if (data.totalCount > limit) {
      html += '<div class="pagination">';
      if (offset > 0) {
        html += `<button class="btn" onclick="loadTabDataNav('${runId}', '${tabDef.id}', '${tabDef.file}', ${Math.max(0, offset - limit)})">前へ</button>`;
      }
      html += `<span>${Math.floor(offset / limit) + 1} / ${Math.ceil(data.totalCount / limit)} ページ</span>`;
      if (offset + limit < data.totalCount) {
        html += `<button class="btn" onclick="loadTabDataNav('${runId}', '${tabDef.id}', '${tabDef.file}', ${offset + limit})">次へ</button>`;
      }
      html += '</div>';
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p class="empty">読み込みに失敗しました: ${err.message}</p>`;
  }
}

// Global function for pagination onclick
window.loadTabDataNav = async function(runId, tabId, file, offset) {
  loadedTabs.delete(tabId);
  const tabDef = { id: tabId, file };
  await loadTabData(runId, tabDef, offset);
};

// --- Before/After comparison view ---

async function loadCompareView(runId, tabDef) {
  const container = document.getElementById('tab-' + tabDef.id);
  if (!container) return;

  try {
    const [sourceData, normalizedData] = await Promise.all([
      api(`/api/runs/${runId}/source-data?offset=0&limit=50`).catch(() => null),
      api(`/api/runs/${runId}/data/normalized.csv?offset=0&limit=50`),
    ]);

    loadedTabs.add(tabDef.id);

    if (!sourceData) {
      container.innerHTML = '<p class="empty">ソースファイルが見つかりません（CSV ファイルのみ対応）</p>';
      return;
    }

    let html = `<p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">元データと正規化後データの並列比較（先頭50件）</p>`;
    html += '<div class="preview-grid">';

    // Before
    html += '<div>';
    html += '<h3 style="margin-bottom:8px">Before（元データ）</h3>';
    html += renderDataTable(sourceData.columns, sourceData.rows);
    html += '</div>';

    // After
    html += '<div>';
    html += '<h3 style="margin-bottom:8px">After（正規化後）</h3>';
    html += renderDataTable(normalizedData.columns, normalizedData.rows, sourceData.rows);
    html += '</div>';

    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p class="empty">比較データの読み込みに失敗しました: ${err.message}</p>`;
  }
}

// --- Duplicate group accordion view ---

async function loadDuplicateGroups(runId, tabDef) {
  const container = document.getElementById('tab-' + tabDef.id);
  if (!container) return;

  try {
    const data = await api(`/api/runs/${runId}/duplicates`);
    loadedTabs.add(tabDef.id);

    if (data.totalGroups === 0) {
      container.innerHTML = '<p class="empty">重複グループはありません</p>';
      return;
    }

    const matchTypeLabels = {
      phone: '電話番号一致',
      email: 'メール一致',
      name_company: '氏名+会社名',
      name_address: '氏名+住所',
    };

    let html = `<p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">${data.totalGroups} グループの重複候補</p>`;

    for (const group of data.groups) {
      const typeLabel = matchTypeLabels[group.matchType] || group.matchType;
      html += `
        <div class="dup-group">
          <div class="dup-group-header" onclick="this.parentElement.classList.toggle('open')">
            <span class="arrow">&#9654;</span>
            <span class="badge badge-info">${typeLabel}</span>
            <span>グループ #${escapeHtml(group.groupId)} — ${group.count} 件</span>
            ${group.matchKey ? `<span style="color:var(--text-secondary);font-size:12px">キー: ${escapeHtml(truncate(group.matchKey, 40))}</span>` : ''}
          </div>
          <div class="dup-group-body">
            ${renderDataTable(Object.keys(group.records[0] || {}), group.records)}
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
  } catch (err) {
    // Fallback to flat table view
    loadedTabs.delete(tabDef.id);
    tabDef.special = null;
    await loadTabData(runId, tabDef, 0);
  }
}

// --- Shared table renderer ---

function renderDataTable(columns, rows, sourceRows) {
  let html = '<div class="table-wrap" style="max-height:500px;overflow:auto">';
  html += '<table><thead><tr>';
  for (const col of columns) {
    html += `<th>${escapeHtml(col)}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    html += '<tr>';
    for (const col of columns) {
      const val = row[col] || '';
      let cls = '';
      if (sourceRows && sourceRows[i]) {
        const origVal = sourceRows[i][col];
        if (origVal !== undefined && origVal !== val && val !== '') {
          cls = ' class="diff-changed"';
        }
      }
      html += `<td${cls} title="${escapeHtml(val)}">${escapeHtml(truncate(val, 60))}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

// --- SSE Progress ---

function connectProgress(runId, onProgress, onDone) {
  const evtSource = new EventSource(`/api/runs/${runId}/progress`);
  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.step === 'done') {
      evtSource.close();
      if (onDone) onDone(data.detail);
    } else {
      if (onProgress) onProgress(data);
    }
  };
  evtSource.onerror = () => {
    evtSource.close();
    if (onDone) onDone('error');
  };
  return evtSource;
}

// --- Helpers ---

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen - 3) + '...';
}

// --- Init ---
loadLabels().then(() => route());
