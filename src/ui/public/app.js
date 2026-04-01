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
  if (path === '/confirm') return renderConfirmPage();
  const colMatch = path.match(/^\/runs\/(.+)\/columns$/);
  if (colMatch) return renderColumnReview(colMatch[1]);
  const runMatch = path.match(/^\/runs\/(.+)$/);
  if (runMatch) return renderRunDetail(runMatch[1]);
  return renderDashboard();
}

// --- Shared state for upload → confirm flow ---
let pendingConfirmation = null; // set by upload-identify response

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
      <div class="btn-group">
        <a href="/reviews/new" class="btn">レビュー</a>
        <a href="/new" class="btn btn-primary">新規 Run</a>
      </div>
    </div>
    <div class="card" id="run-list-card">
      <h3>直近の実行結果</h3>
      <div class="loading">読み込み中...</div>
    </div>
    <div class="card" id="review-list-card" style="display:none">
      <h3>レビュー</h3>
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
    // Load reviews for dashboard
    try {
      const reviews = await api('/api/reviews');
      if (reviews.length > 0) {
        const revCard = document.getElementById('review-list-card');
        revCard.style.display = '';
        let revHtml = `<h3>レビュー (${reviews.length}件)</h3><div class="run-list">`;
        for (const rev of reviews) {
          const statusBadge = rev.reviewStatus === 'draft'
            ? '<span class="badge badge-warning">下書き</span>'
            : rev.reviewStatus === 'reviewed'
              ? '<span class="badge badge-info">レビュー済</span>'
              : `<span class="badge">${rev.reviewStatus}</span>`;
          const time = new Date(rev.updatedAt).toLocaleString('ja-JP');
          revHtml += `
            <a href="/reviews/${rev.id}/columns" class="run-item">
              <span class="run-mode">${escapeHtml(rev.fileName)}</span>
              ${statusBadge}
              <span class="run-files">${rev.reviewer || '—'}</span>
              <span class="run-time">${time}</span>
            </a>
          `;
        }
        revHtml += '</div>';
        revCard.innerHTML = revHtml;
      }
    } catch { /* ignore review load error */ }

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
          <button type="button" class="btn btn-primary" id="confirm-btn">ファイルを確認</button>
          <button type="submit" class="btn" id="run-submit">確認せず実行</button>
          <button type="button" class="btn" id="preview-btn">プレビュー</button>
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

  // Confirm button handler — upload & identify file, then show confirm page
  const confirmBtn = $('#confirm-btn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const form = $('#run-form');
      const status = $('#run-status');

      if (uploadedFiles.length === 0) {
        const filePaths = form.filePaths.value.split('\n').map(s => s.trim()).filter(Boolean);
        if (filePaths.length === 0) {
          alert('ファイルを選択してください');
          return;
        }
        // For local path files, use the preview API to identify
        try {
          status.textContent = 'ファイルを確認中...';
          const enc = form.encoding.value;
          const data = await api(`/api/preview?file=${encodeURIComponent(filePaths[0])}&encoding=${enc}&rows=10`);
          const profileMatch = await api(`/api/profiles`).then(profiles => {
            // Do client-side matching by calling identify endpoint
            return null;
          }).catch(() => null);

          // Simulate upload-identify response
          pendingConfirmation = {
            filename: filePaths[0].split('/').pop(),
            filePath: filePaths[0],
            diagnosis: data.diagnosis || {},
            previewRows: data.sampleRows || [],
            columns: data.columns || [],
            profileMatch: { profile: null, confidence: 'none', reason: '', alternatives: [] },
            formState: {
              mode: form.mode.value,
              configPath: form.configPath.value,
              encoding: form.encoding.value,
              delimiter: form.delimiter.value,
              hasHeader: form.hasHeader.checked,
              filePathsText: filePaths,
            },
          };
          status.textContent = '';
          navigate('/confirm');
        } catch (err) {
          status.textContent = 'エラー: ' + err.message;
          status.style.color = 'var(--danger)';
        }
        return;
      }

      // Upload file and identify
      try {
        status.textContent = 'ファイルを確認中...';
        const formData = new FormData();
        formData.append('file', uploadedFiles[0]);
        formData.append('encoding', form.encoding.value);
        formData.append('hasHeader', form.hasHeader.checked ? 'true' : 'false');

        const res = await fetch('/api/upload-identify', { method: 'POST', body: formData });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();

        pendingConfirmation = {
          ...data,
          formState: {
            mode: form.mode.value,
            configPath: form.configPath.value,
            encoding: form.encoding.value,
            delimiter: form.delimiter.value,
            hasHeader: form.hasHeader.checked,
            filePathsText: form.filePaths.value.split('\n').map(s => s.trim()).filter(Boolean),
            uploadedFiles: uploadedFiles.slice(),
          },
        };
        status.textContent = '';
        navigate('/confirm');
      } catch (err) {
        status.textContent = 'エラー: ' + err.message;
        status.style.color = 'var(--danger)';
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
          <button class="btn btn-primary" id="btn-start-review-from-run" title="列レビューを開始">列レビュー</button>
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

    // 列確認カードを非同期でロード
    loadColumnStatusCard(runId);

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

    // Start column review from run detail
    document.getElementById('btn-start-review-from-run').addEventListener('click', () => {
      navigate(`/runs/${runId}/columns`);
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

// --- Column status card (run detail) ---

async function loadColumnStatusCard(runId) {
  try {
    const status = await api(`/api/runs/${runId}/column-status`);
    if (!status.entries || status.entries.length === 0) return;

    const entry = status.entries[0];
    const cardHtml = `
      <div class="card" id="column-status-card">
        <h2>列の確認状況</h2>
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
          ファイル種別: <strong>${escapeHtml(entry.profileName)}</strong>
        </p>
        <div class="stats" style="margin-bottom:12px">
          <div class="stat"><div class="label">使う列</div><div class="value">${entry.activeCount}</div></div>
          <div class="stat"><div class="label">使わない列</div><div class="value">${entry.unusedCount}</div></div>
          <div class="stat"><div class="label">まだ決まっていない列</div><div class="value">${entry.pendingCount}</div></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a href="/runs/${escapeHtml(runId)}/columns" class="btn btn-primary">列の確認を再開</a>
          <button
            class="btn"
            id="btn-save-candidate"
            onclick="saveCandidateFromRun('${escapeHtml(runId)}', '${escapeHtml(entry.profileId)}')"
            title="この列の設定を次回も使えるように保存します"
          >この設定を保存</button>
        </div>
        <p id="save-candidate-msg" style="font-size:11px;color:var(--text-secondary);margin-top:4px;display:none"></p>
        <p style="font-size:11px;color:var(--text-secondary);margin-top:8px">
          この内容はあとから続けられます
        </p>
      </div>
    `;
    // サマリカードの直後に挿入
    const summaryCard = app.querySelector('.card');
    if (summaryCard) {
      summaryCard.insertAdjacentHTML('afterend', cardHtml);
    }
  } catch { /* ignore — column status is optional */ }
}

async function saveCandidateFromRun(runId, profileId) {
  const btn = document.getElementById('btn-save-candidate');
  const msg = document.getElementById('save-candidate-msg');
  if (!btn || !msg) return;

  btn.disabled = true;
  btn.textContent = '保存中...';

  try {
    await api(`/api/runs/${runId}/save-candidate-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    btn.textContent = '保存済み ✓';
    msg.textContent = 'この設定は次回も候補として表示されます';
    msg.style.display = 'block';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'この設定を保存';
    msg.textContent = '保存に失敗しました。もう一度お試しください。';
    msg.style.display = 'block';
    msg.style.color = 'var(--danger, #dc3545)';
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

// --- Pre-run diff preview card (重複再投入ガード) ---

function renderPreRunPreviewCard(preview) {
  if (!preview) return '';
  const cls = preview.classification;
  const label = preview.classificationLabel || '';

  let icon = '○';
  let color = '#6b7280';
  let bgColor = '#f9fafb';
  if (cls === 'same_file') {
    icon = '！';
    color = '#b45309';
    bgColor = '#fef3c7';
  } else if (cls === 'first_import') {
    icon = '★';
    color = '#6366f1';
    bgColor = '#ede9fe';
  } else if (cls === 'column_changed') {
    icon = '！';
    color = '#d97706';
    bgColor = '#fef3c7';
  } else if (cls === 'row_changed') {
    icon = '↑';
    color = '#2563eb';
    bgColor = '#dbeafe';
  }

  let detailLines = '';
  if (preview.rowCountPrev !== null) {
    detailLines += `<div style="font-size:12px;color:#6b7280;margin-top:4px">前回の件数: <strong>${Number(preview.rowCountPrev).toLocaleString('ja-JP')}件</strong></div>`;
  }
  if (preview.columnCountDelta !== null && preview.columnCountDelta !== 0) {
    const sign = preview.columnCountDelta > 0 ? '+' : '';
    detailLines += `<div style="font-size:12px;color:${color};margin-top:2px">列数の変化: <strong>${sign}${preview.columnCountDelta}列</strong>（前回 ${preview.columnCountPrev ?? '?'}列 → 今回 ${preview.columnCountCurr}列）</div>`;
  } else if (preview.columnCountPrev !== null) {
    detailLines += `<div style="font-size:12px;color:#6b7280;margin-top:2px">列数: <strong>${preview.columnCountCurr}列</strong>（前回と同じ）</div>`;
  }

  return `
    <div class="card" style="background:${bgColor};border:1px solid ${color};padding:12px 16px">
      <div style="font-size:13px;font-weight:600;color:${color}">${icon} ${escapeHtml(label)}</div>
      ${detailLines}
    </div>
  `;
}

// --- Confirm Page (upload → identify → confirm) ---

async function renderConfirmPage() {
  let currentPreRunPreview = null;

  if (!pendingConfirmation) {
    navigate('/new');
    return;
  }

  const data = pendingConfirmation;
  const pm = data.profileMatch || { profile: null, confidence: 'none', reason: '', alternatives: [] };
  const diag = data.diagnosis || {};

  // Determine encoding display
  const encodingDisplay = diag.format === 'csv'
    ? `${diag.detectedEncoding || '不明'} → ${diag.appliedEncoding || '不明'}`
    : 'XLSX';

  // Check for potential mojibake in preview
  const hasMojibake = data.previewRows && data.previewRows.length > 0 &&
    JSON.stringify(data.previewRows).includes('\\ufffd');

  // Load all profiles for alternative selection
  let allProfiles = [];
  try { allProfiles = await api('/api/profiles'); } catch { /* ignore */ }

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">ファイルの確認</h2>
      <a href="/new" class="btn">戻る</a>
    </div>

    <div class="card">
      <h2>このファイルは何の一覧ですか？</h2>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
        ファイル名: <strong>${escapeHtml(data.filename)}</strong>
      </p>
  `;

  // Profile match result
  if (pm.profile) {
    const provLabel = pm.profile.provisional ? ' <span class="badge badge-warning">仮</span>' : '';
    const candidateBadge = pm.profile?.candidate
      ? '<span style="font-size:10px;background:#f0ad4e;color:#fff;padding:1px 6px;border-radius:4px;margin-left:6px">仮の設定</span>'
      : '';
    html += `
      <div class="confirm-choice-card selected" id="choice-known">
        <div class="confirm-choice-header">
          <input type="radio" name="file-type-choice" value="known" checked>
          <strong>「${escapeHtml(pm.profile.label)}」として扱う</strong>${provLabel}${candidateBadge}
          <span class="badge badge-info">${escapeHtml(pm.reason)}</span>
        </div>
        <p style="font-size:12px;color:var(--text-secondary);margin:4px 0 0 24px">
          分類: ${escapeHtml(pm.profile.category)} ｜ 列数: ${pm.profile.columns.length}
        </p>
      </div>
    `;
  }

  // Alternatives
  if (pm.alternatives && pm.alternatives.length > 0) {
    html += `<div class="confirm-choice-card" id="choice-alt">
      <div class="confirm-choice-header">
        <input type="radio" name="file-type-choice" value="alt">
        <strong>別の種別を選ぶ</strong>
      </div>
      <div class="confirm-alt-list" style="margin:8px 0 0 24px;display:none">
        <select id="alt-profile-select" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px">
          ${pm.alternatives.map(a =>
            `<option value="${escapeHtml(a.profile.id)}">${escapeHtml(a.profile.label)} (${escapeHtml(a.reason)})</option>`
          ).join('')}
          ${allProfiles.filter(p => p.id !== pm.profile?.id && !pm.alternatives.some(a => a.profile.id === p.id)).map(p =>
            `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`
          ).join('')}
        </select>
      </div>
    </div>`;
  } else if (allProfiles.length > 0) {
    html += `<div class="confirm-choice-card" id="choice-alt">
      <div class="confirm-choice-header">
        <input type="radio" name="file-type-choice" value="alt" ${!pm.profile ? 'checked' : ''}>
        <strong>既存の種別から選ぶ</strong>
      </div>
      <div class="confirm-alt-list" style="margin:8px 0 0 24px;${pm.profile ? 'display:none' : ''}">
        <select id="alt-profile-select" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px">
          ${allProfiles.map(p =>
            `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)} (${escapeHtml(p.category)})</option>`
          ).join('')}
        </select>
      </div>
    </div>`;
  }

  // New file option
  html += `
    <div class="confirm-choice-card" id="choice-new">
      <div class="confirm-choice-header">
        <input type="radio" name="file-type-choice" value="new" ${!pm.profile && allProfiles.length === 0 ? 'checked' : ''}>
        <strong>新しいファイルとして扱う</strong>
      </div>
      <p style="font-size:12px;color:var(--text-secondary);margin:4px 0 0 24px">
        列ごとの意味を入力して、新しいファイル種別を作ります
      </p>
    </div>
  </div>
  `;

  // Header check
  html += `
    <div class="card">
      <h2>1行目は見出しですか？</h2>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
        データの1行目を確認してください。列の名前（見出し）が入っていれば「はい」を選んでください。
      </p>
      <div style="display:flex;gap:12px;margin-bottom:12px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="has-header" value="true" ${diag.headerApplied !== false ? 'checked' : ''}> はい（見出しあり）
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="has-header" value="false" ${diag.headerApplied === false ? 'checked' : ''}> いいえ（データのみ）
        </label>
      </div>
      ${data.columns && data.columns.length > 0 ? `
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">検出された見出し:</p>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
          ${data.columns.map(c => `<span class="badge badge-info">${escapeHtml(c)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;

  // Encoding / mojibake check
  html += `
    <div class="card">
      <h2>文字化けしていませんか？</h2>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
        文字コード: ${escapeHtml(encodingDisplay)}
      </p>
      ${hasMojibake ? `
        <div style="padding:8px 12px;background:#fee2e2;border-radius:4px;margin-bottom:8px;font-size:13px;color:var(--danger)">
          文字化けの可能性があります。文字コードを変更して再試行してください。
        </div>
      ` : `
        <div style="padding:8px 12px;background:#dcfce7;border-radius:4px;margin-bottom:8px;font-size:13px;color:var(--success)">
          正常に読み取れています
        </div>
      `}
  `;

  // Preview table
  if (data.previewRows && data.previewRows.length > 0 && data.columns) {
    html += `
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">先頭 ${data.previewRows.length} 件のプレビュー:</p>
      ${renderDataTable(data.columns, data.previewRows)}
    `;
  }

  html += `
      <div style="margin-top:12px">
        <label style="font-size:13px;font-weight:600;color:var(--text-secondary)">文字コードを変更して再読み込み</label>
        <div style="display:flex;gap:8px;margin-top:4px">
          <select id="retry-encoding" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px">
            <option value="auto">自動検出</option>
            <option value="cp932" ${(diag.appliedEncoding === 'cp932') ? 'selected' : ''}>Shift-JIS (CP932)</option>
            <option value="utf8" ${(diag.appliedEncoding === 'utf8') ? 'selected' : ''}>UTF-8</option>
          </select>
          <button type="button" class="btn" id="retry-encoding-btn">再読み込み</button>
        </div>
      </div>
    </div>
  `;

  // Duplicate warning placeholder (filled asynchronously after pre-run preview loads)
  html += `<div id="duplicate-warning-container"></div>`;

  // Action buttons
  html += `
    <div id="action-area" style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="confirm-proceed-btn">確認して実行</button>
      <a href="/new" class="btn">戻る</a>
    </div>
  `;

  app.innerHTML = html;

  // Pre-run preview を非同期で取得（confirm フローを止めない）
  (async () => {
    try {
      const params = new URLSearchParams({
        filename: data.filename || '',
        columnCount: String((data.columns || []).length),
      });
      if (data.sourceFileHash) params.set('sourceFileHash', data.sourceFileHash);
      if (data.schemaFingerprint) params.set('schemaFingerprint', data.schemaFingerprint);

      currentPreRunPreview = await api(`/api/pre-run-preview?${params.toString()}`);

      const warningContainer = document.getElementById('duplicate-warning-container');
      if (!warningContainer) return;

      if (currentPreRunPreview?.duplicateWarning) {
        // duplicate warning あり → カードと分岐ボタンを表示
        const prevRunId = currentPreRunPreview.previousRunId;
        warningContainer.innerHTML = `
          <div class="card" style="background:#fef3c7;border:1px solid #b45309;padding:12px 16px;margin-bottom:0">
            <div style="font-size:13px;font-weight:600;color:#b45309">！ 前回と同じ内容の可能性があります</div>
            <div style="font-size:12px;color:#6b7280;margin-top:4px">前回の結果を確認してから進めることをおすすめします。<br>必要な場合だけもう一度実行してください。</div>
            ${currentPreRunPreview.rowCountPrev !== null
              ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">前回の件数: <strong>${Number(currentPreRunPreview.rowCountPrev).toLocaleString('ja-JP')}件</strong></div>`
              : ''}
            ${prevRunId ? `
            <div style="margin-top:10px">
              <a href="/runs/${encodeURIComponent(prevRunId)}" class="btn" style="font-size:13px">前回の結果を見る</a>
            </div>` : ''}
          </div>
        `;

        // action area を更新：「それでも実行する」を明示
        const actionArea = document.getElementById('action-area');
        if (actionArea) {
          actionArea.innerHTML = `
            <button class="btn" id="confirm-proceed-btn" style="font-size:12px;color:#6b7280">それでも実行する</button>
            <a href="/new" class="btn">戻る</a>
          `;
          // proceed ボタンを再バインド（duplicate override あり）
          const overrideBtn = document.getElementById('confirm-proceed-btn');
          if (overrideBtn) {
            overrideBtn.addEventListener('click', async () => {
              await executeProceed({ data, pm, duplicateWarningShown: true, duplicateOverride: true });
            });
          }
        }
      } else if (currentPreRunPreview && !currentPreRunPreview.duplicateWarning) {
        // duplicate warning なし → 軽量な状態カードを表示
        warningContainer.innerHTML = renderPreRunPreviewCard(currentPreRunPreview);
      }
    } catch {
      // 取得失敗は無視（confirm フローを止めない）
    }
  })();

  // Wire up radio button interactions
  document.querySelectorAll('input[name="file-type-choice"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.confirm-choice-card').forEach(c => c.classList.remove('selected'));
      radio.closest('.confirm-choice-card').classList.add('selected');
      // Show/hide alt selection
      const altList = document.querySelector('.confirm-alt-list');
      if (altList) altList.style.display = radio.value === 'alt' ? '' : 'none';
    });
  });

  // Retry encoding button
  const retryBtn = document.getElementById('retry-encoding-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      const enc = document.getElementById('retry-encoding').value;
      const hasHeader = document.querySelector('input[name="has-header"]:checked')?.value !== 'false';
      try {
        if (data.filePath) {
          const newData = await api(`/api/preview?file=${encodeURIComponent(data.filePath)}&encoding=${enc}&hasHeader=${hasHeader}&rows=10`);
          pendingConfirmation = {
            ...data,
            diagnosis: newData.diagnosis || data.diagnosis,
            previewRows: newData.sampleRows || [],
            columns: newData.columns || [],
            profileMatch: matchProfileClient(data.filename, newData.columns || [], pendingConfirmation.profileMatch),
          };
        } else {
          // Re-upload for uploaded files
          const formData = new FormData();
          formData.append('file', data.formState.uploadedFiles?.[0] || uploadedFiles[0]);
          formData.append('encoding', enc);
          formData.append('hasHeader', hasHeader ? 'true' : 'false');
          const res = await fetch('/api/upload-identify', { method: 'POST', body: formData });
          const newData = await res.json();
          pendingConfirmation = {
            ...newData,
            formState: data.formState,
          };
        }
        renderConfirmPage();
      } catch (err) {
        alert('再読み込みに失敗しました: ' + err.message);
      }
    });
  }

  async function executeProceed({ data, pm, duplicateWarningShown = false, duplicateOverride = false } = {}) {
    const choice = document.querySelector('input[name="file-type-choice"]:checked')?.value;
    const hasHeader = document.querySelector('input[name="has-header"]:checked')?.value !== 'false';
    const fs = data.formState;

    const ingestOptions = {
      encoding: document.getElementById('retry-encoding')?.value || fs.encoding,
      delimiter: fs.delimiter,
      hasHeader,
    };

    let selectedProfileId = null;
    if (choice === 'known' && pm.profile) {
      selectedProfileId = pm.profile.id;
    } else if (choice === 'alt') {
      selectedProfileId = document.getElementById('alt-profile-select')?.value;
    }

    const proceedBtn = document.getElementById('confirm-proceed-btn');
    if (proceedBtn) {
      proceedBtn.disabled = true;
      proceedBtn.textContent = '実行中...';
    }

    try {
      let result;
      if (data.filePath && !fs.uploadedFiles?.length) {
        result = await api('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: fs.mode,
            configPath: fs.configPath,
            filePaths: [data.filePath],
            ingestOptions,
            duplicateWarningShown,
            duplicateOverride,
          }),
        });
      } else {
        const formData = new FormData();
        formData.append('mode', fs.mode);
        if (fs.configPath) formData.append('configPath', fs.configPath);
        if (fs.uploadedFiles) {
          for (const f of fs.uploadedFiles) formData.append('files', f);
        } else {
          for (const f of uploadedFiles) formData.append('files', f);
        }
        if (fs.filePathsText?.length > 0) {
          formData.append('filePaths', JSON.stringify(fs.filePathsText));
        }
        formData.append('ingestOptions', JSON.stringify(ingestOptions));
        if (duplicateWarningShown) formData.append('duplicateWarningShown', 'true');
        if (duplicateOverride) formData.append('duplicateOverride', 'true');

        const res = await fetch('/api/runs', { method: 'POST', body: formData });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        result = await res.json();
      }

      if (choice === 'new') {
        pendingConfirmation = { ...data, runId: result.id, selectedProfileId: null };
        navigate(`/runs/${result.id}/columns`);
      } else if (selectedProfileId) {
        pendingConfirmation = { ...data, runId: result.id, selectedProfileId };
        navigate(`/runs/${result.id}/columns`);
      } else {
        navigate(`/runs/${result.id}`);
      }
    } catch (err) {
      if (proceedBtn) {
        proceedBtn.disabled = false;
        proceedBtn.textContent = duplicateOverride ? 'それでも実行する' : '確認して実行';
      }
      alert('実行に失敗しました: ' + err.message);
    }
  }

  // Proceed button（duplicate warning がない場合の通常フロー）
  const proceedBtn = document.getElementById('confirm-proceed-btn');
  if (proceedBtn) {
    proceedBtn.addEventListener('click', () => {
      executeProceed({ data, pm });
    });
  }
}

// Simple client-side matching helper (preserves server match if available)
function matchProfileClient(filename, columns, existingMatch) {
  return existingMatch || { profile: null, confidence: 'none', reason: '', alternatives: [] };
}

// --- Column Review Page ---

async function renderColumnReview(runId) {
  app.innerHTML = '<div class="loading">読み込み中...</div>';

  // pendingConfirmation がこの runId 用かチェック
  const hasPending = pendingConfirmation && pendingConfirmation.runId === runId;
  const data = hasPending ? pendingConfirmation : {};

  let selectedProfileId = data.selectedProfileId ?? null;
  let columns = data.columns ? [...data.columns] : [];

  // pendingConfirmation がない場合は保存済みデータから resume
  if (!hasPending) {
    try {
      const status = await api(`/api/runs/${runId}/column-status`);
      if (status.entries && status.entries.length > 0) {
        const entry = status.entries[0]; // 先頭を使う（通常 1 件）
        selectedProfileId = entry.profileId;
        // columns を effective mapping の sourceHeader から復元
        if (entry.columns && entry.columns.length > 0) {
          columns = entry.columns.map(c => c.sourceHeader);
        }
      }
    } catch { /* ignore, proceed with empty */ }

    // それでも columns が空なら source-data から取得
    if (columns.length === 0) {
      try {
        const rd = await api(`/api/runs/${runId}/source-data?offset=0&limit=5`);
        if (rd.columns) columns = rd.columns;
      } catch { /* ignore */ }
    }
  }

  const reviewProfileId = selectedProfileId || 'new';

  // Load profile if known
  let profile = null;
  if (selectedProfileId && selectedProfileId !== 'new') {
    try { profile = await api(`/api/profiles/${selectedProfileId}`); } catch { /* ignore */ }
  }

  // Load existing review
  let existingReview = null;
  try {
    const r = await api(`/api/column-reviews/${runId}/${reviewProfileId}`);
    existingReview = r.reviews;
  } catch { /* ignore */ }

  // Load preview rows
  let previewRows = data.previewRows || [];
  if (previewRows.length === 0) {
    try {
      const rd = await api(`/api/runs/${runId}/source-data?offset=0&limit=5`);
      previewRows = rd.rows || [];
      if (columns.length === 0 && rd.columns) columns = rd.columns;
    } catch { /* ignore */ }
  }

  // columns が結局空 → 案内して終了
  if (columns.length === 0 && !existingReview) {
    app.innerHTML = `
      <div class="card">
        <h2>列情報が見つかりません</h2>
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
          この Run の列情報がまだ保存されていません。<br>
          ファイルをアップロードして確認してから進めてください。
        </p>
        <a href="/" class="btn">ダッシュボードに戻る</a>
      </div>
    `;
    return;
  }

  // Build column entries
  const entries = columns.map((col, i) => {
    const profileCol = profile?.columns?.find(c => c.position === i);
    const existing = existingReview?.find(r => r.position === i);
    const samples = previewRows.slice(0, 5).map(r => r[col]).filter(Boolean);

    return {
      position: i,
      headerName: col,
      profileLabel: profileCol?.label || '',
      profileKey: profileCol?.key || '',
      profileRequired: profileCol?.required ?? false,
      profileRule: profileCol?.rule || '',
      samples,
      meaning: existing?.meaning ?? profileCol?.label ?? '',
      inUse: existing?.inUse ?? 'unknown',
      required: existing?.required ?? (profileCol?.required ? 'yes' : 'unknown'),
      rule: existing?.rule ?? profileCol?.rule ?? '',
    };
  });

  const isResume = !hasPending && existingReview;
  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">列の確認</h2>
      <div class="btn-group">
        <button class="btn btn-primary" id="save-review-btn">保存</button>
        <a href="/runs/${escapeHtml(runId)}" class="btn">あとで続ける</a>
      </div>
    </div>

    <div class="card">
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
        ${profile ? `「<strong>${escapeHtml(profile.label)}</strong>」の列を確認してください。` : '各列の意味を教えてください。'}
        ${profile?.provisional ? '<span class="badge badge-warning">仮の定義です — 確認をお願いします</span>' : ''}
        ${isResume ? '<span class="badge badge-info">保存済みの回答から続きを表示しています</span>' : ''}
      </p>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px">
        わからない場合は、そのままで大丈夫です。あとから修正できます。
      </p>
  `;

  for (const entry of entries) {
    html += `
      <div class="column-review-item" data-position="${entry.position}">
        <div class="column-review-header">
          <span class="badge badge-info">${entry.position + 1}列目</span>
          <strong>${escapeHtml(entry.headerName)}</strong>
          ${entry.profileLabel ? `<span style="font-size:12px;color:var(--text-secondary)">（候補: ${escapeHtml(entry.profileLabel)}）</span>` : ''}
        </div>

        ${entry.samples.length > 0 ? `
          <div style="margin:6px 0 8px 0;font-size:12px;color:var(--text-secondary)">
            例: ${entry.samples.slice(0, 3).map(s => `<code style="background:var(--bg);padding:1px 4px;border-radius:2px">${escapeHtml(truncate(s, 30))}</code>`).join(', ')}
          </div>
        ` : ''}

        <div class="column-review-fields">
          <div class="column-review-field">
            <label>この列は何を入れる場所ですか？</label>
            <input type="text" class="col-meaning" value="${escapeHtml(entry.meaning)}" placeholder="例: 会社名、電話番号 など">
          </div>
          <div class="column-review-field">
            <label>今も使いますか？</label>
            <select class="col-inuse">
              <option value="unknown" ${entry.inUse === 'unknown' ? 'selected' : ''}>わからない</option>
              <option value="yes" ${entry.inUse === 'yes' ? 'selected' : ''}>はい</option>
              <option value="no" ${entry.inUse === 'no' ? 'selected' : ''}>いいえ（不要）</option>
            </select>
          </div>
          <div class="column-review-field">
            <label>必須ですか？</label>
            <select class="col-required">
              <option value="unknown" ${entry.required === 'unknown' ? 'selected' : ''}>わからない</option>
              <option value="yes" ${entry.required === 'yes' ? 'selected' : ''}>はい（必須）</option>
              <option value="no" ${entry.required === 'no' ? 'selected' : ''}>いいえ</option>
            </select>
          </div>
          <div class="column-review-field">
            <label>入力ルールがありますか？</label>
            <input type="text" class="col-rule" value="${escapeHtml(entry.rule)}" placeholder="例: 半角数字のみ、日付形式 など">
          </div>
        </div>
      </div>
    `;
  }

  html += `
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="save-review-btn-bottom">保存して結果を見る</button>
      <a href="/runs/${escapeHtml(runId)}" class="btn">あとで続ける</a>
    </div>
  `;

  app.innerHTML = html;

  // Save review handler
  const saveHandler = async () => {
    const items = document.querySelectorAll('.column-review-item');
    const reviews = [];
    items.forEach(item => {
      const pos = parseInt(item.dataset.position);
      reviews.push({
        position: pos,
        label: columns[pos] || '',
        key: entries[pos]?.profileKey || columns[pos] || '',
        meaning: item.querySelector('.col-meaning')?.value || '',
        inUse: item.querySelector('.col-inuse')?.value || 'unknown',
        required: item.querySelector('.col-required')?.value || 'unknown',
        rule: item.querySelector('.col-rule')?.value || '',
      });
    });

    try {
      const result = await api(`/api/column-reviews/${runId}/${reviewProfileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviews }),
      });

      if (result.effectiveSummary) {
        showColumnReviewSummary(runId, reviewProfileId, result.effectiveSummary);
      } else {
        navigate(`/runs/${runId}`);
      }
    } catch (err) {
      alert('保存に失敗しました: ' + err.message);
    }
  };

  document.getElementById('save-review-btn')?.addEventListener('click', saveHandler);
  document.getElementById('save-review-btn-bottom')?.addEventListener('click', saveHandler);
}

// --- 列レビュー保存後のサマリ表示 ---
function showColumnReviewSummary(runId, profileId, summary) {
  const { activeCount, unusedCount, pendingCount } = summary;

  app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px">回答を保存しました</h2>
    </div>
    <div class="card">
      <p style="font-size:13px;margin-bottom:16px">
        この回答が保存されました。次の確認に使われます。
      </p>
      <div class="stats" style="margin-bottom:16px">
        <div class="stat">
          <div class="label">使う列</div>
          <div class="value">${activeCount}</div>
        </div>
        <div class="stat">
          <div class="label">使わない列</div>
          <div class="value">${unusedCount}</div>
        </div>
        <div class="stat">
          <div class="label">未確定</div>
          <div class="value">${pendingCount}</div>
        </div>
      </div>
      ${activeCount > 0 ? `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="btn-normalize-with-review">この回答を使って正規化を実行</button>
          <a href="/runs/${escapeHtml(runId)}" class="btn">結果を見る</a>
        </div>
        <p style="font-size:12px;color:var(--text-secondary);margin-top:8px">
          「使う列」${activeCount}件の名前を整えて、正規化ファイルを作成します。
        </p>
      ` : `
        <div style="display:flex;gap:8px">
          <a href="/runs/${escapeHtml(runId)}" class="btn btn-primary">結果を見る</a>
        </div>
      `}
    </div>
  `;

  document.getElementById('btn-normalize-with-review')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-normalize-with-review');
    btn.disabled = true;
    btn.textContent = '実行中...';
    try {
      const result = await api(`/api/runs/${runId}/rerun-with-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId }),
      });
      navigate(`/runs/${result.id}`);
    } catch (err) {
      alert('実行に失敗しました: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'この回答を使って正規化を実行';
    }
  });
}

// --- Init ---
loadLabels().then(() => route());
