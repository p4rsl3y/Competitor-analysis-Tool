(function () { // IIFE to avoid polluting the global scope
  // ── Shared State & Setup ──────────────────────────────────────────────────────
  let MODELS = { openai: [], anthropic: [] };
  let activeTab = 'research';

  function switchTab(tabId) {
    // This function is now called by our event listener
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    // Find button by data-attribute
    const newActiveButton = document.querySelector(`.tab-btn[data-tab='${tabId}']`);
    if (newActiveButton) {
      newActiveButton.classList.add('active');
    }

    document.getElementById(`tab-${tabId}`).classList.add('active');
    activeTab = tabId;
    hide('errorBox'); hide('loading');
  }

  async function fetchModels() {
    try {
      const res = await fetch('/api/models');
      if (res.ok) { MODELS = await res.json(); populateModels(document.getElementById('providerSelect').value); }
    } catch (err) { console.error("Model fetch failed."); }
  }

  function populateModels(provider) {
    const select = document.getElementById('modelSelect');
    if (!MODELS[provider] || MODELS[provider].length === 0) {
      select.innerHTML = '<option>Loading...</option>';
    } else {
      select.innerHTML = MODELS[provider].map(m => `<option value="${m.value}">${m.label}</option>`).join('');
    }

    // Explicitly update the token widget to reflect the new default model
    updateTokenWidget();
  }

  function onProviderChange() { populateModels(document.getElementById('providerSelect').value); }

  function show(id) { document.getElementById(id).classList.remove('hidden'); }
  function hide(id) { document.getElementById(id).classList.add('hidden'); }

  function updateProgress(percent, text) {
    const bar = document.getElementById('loadingProgress');
    const status = document.getElementById('loadingStatusText');
    if (bar) bar.style.width = percent + '%';
    if (status && text) status.innerText = text;
  }

  function startLog(title) {
    hide('errorBox'); show('loading');
    document.getElementById('loadingTitle').textContent = title;
    document.getElementById('activityLog').innerHTML = '';
    updateProgress(0, "Initializing...");
    document.querySelectorAll('.search-btn-main').forEach(btn => btn.disabled = true);
  }

  function stopLoading() {
    hide('loading');
    updateProgress(100, "Complete");
    document.querySelectorAll('.search-btn-main').forEach(btn => btn.disabled = false);
  }

  function addLog(text) {
    const log = document.getElementById('activityLog');
    const prev = log.querySelector('.log-line.active');
    if (prev) { prev.classList.remove('active'); prev.querySelector('.log-dot').className = 'log-dot'; }
    log.innerHTML += `<div class="log-line active"><span class="log-dot spinning"></span><span>${text}</span></div>`;
    // The line below was removed as the element 'loadingSub' does not exist in the HTML and causes a runtime error.
    // document.getElementById('loadingSub').textContent = text;
  }

  // ── Tab 1: Research Logic ─────────────────────────────────────────────────────
  const DEFAULT_COLS = [
    { id: 1, name: "Size", format: "tags", instructions: "Closest range.", tags: "<50, 51-200, 201-1000, >1000" },
    { id: 2, name: "Pricing", format: "text", instructions: "Core model.", tags: "" }
  ];
  let columnState = [];
  let presetState = {};
  let lastUsedColumns = [];
  let lastResults = null;

  // Logic to load, save, and delete presets
  function loadPreset(name) {
    if (!name || !presetState[name]) return;
    // Deep clone to prevent accidental modification of the preset itself
    columnState = JSON.parse(JSON.stringify(presetState[name]));
    renderColumnBuilder();
    persistSettings();

    // Show/hide delete button based on whether it's a custom preset
    const deleteBtn = document.getElementById('deletePresetBtn');
    name === "Standard" ? deleteBtn.classList.add('hidden') : deleteBtn.classList.remove('hidden');
  }

  function saveCurrentAsPreset() {
    const name = prompt("Enter a name for this preset:");
    if (!name) return;
    presetState[name] = JSON.parse(JSON.stringify(columnState));
    renderPresetsDropdown();
    persistSettings();
    document.getElementById('presetSelect').value = name;
  }

  function deletePreset() {
    const name = document.getElementById('presetSelect').value;
    if (!name || name === "Standard") return;
    if (confirm(`Delete preset "${name}"?`)) {
      delete presetState[name];
      renderPresetsDropdown();
      persistSettings();
      loadPreset("Standard");
    }
  }

  // ── Modular Help Popover Logic ───────────────────────────────────────────────
  let activeHelpId = null;

  function showHelp(baseId) {
    if (activeHelpId !== baseId) {
      document.getElementById(baseId + 'Popover').classList.add('visible');
    }
  }

  function hideHelp(baseId) {
    if (activeHelpId !== baseId) {
      document.getElementById(baseId + 'Popover').classList.remove('visible');
    }
  }

  function closeHelpOnOutsideClick(event) {
    if (activeHelpId) {
      const icon = document.getElementById(activeHelpId + 'Icon');
      const popover = document.getElementById(activeHelpId + 'Popover');

      if (icon && !icon.contains(event.target)) {
        icon.classList.remove('pinned');
        popover.classList.remove('visible');
        activeHelpId = null;
        document.removeEventListener('click', closeHelpOnOutsideClick);
      }
    }
  }

  function toggleHelp(baseId) {
    const icon = document.getElementById(baseId + 'Icon');
    const popover = document.getElementById(baseId + 'Popover');

    if (activeHelpId === baseId) {
      // Unpin the currently open menu
      icon.classList.remove('pinned');
      activeHelpId = null;
      document.removeEventListener('click', closeHelpOnOutsideClick);
      if (!icon.matches(':hover')) hideHelp(baseId);
    } else {
      // Close any other menu that is currently pinned
      if (activeHelpId) {
        const oldIcon = document.getElementById(activeHelpId + 'Icon');
        const oldPopover = document.getElementById(activeHelpId + 'Popover');
        if (oldIcon) oldIcon.classList.remove('pinned');
        if (oldPopover) oldPopover.classList.remove('visible');
        document.removeEventListener('click', closeHelpOnOutsideClick);
      }

      // Pin the new menu
      activeHelpId = baseId;
      icon.classList.add('pinned');
      popover.classList.add('visible');

      setTimeout(() => {
        document.addEventListener('click', closeHelpOnOutsideClick);
      }, 0);
    }
  }

  async function initColumns() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      columnState = data.columns?.length ? data.columns : [...DEFAULT_COLS];
      presetState = Object.keys(data.presets || {}).length ? data.presets : { "Standard": [...DEFAULT_COLS] };
    } catch (e) { columnState = [...DEFAULT_COLS]; presetState = { "Standard": [...DEFAULT_COLS] }; }
    renderColumnBuilder(); renderPresetsDropdown();
  }
  function persistSettings() { fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ columns: columnState, presets: presetState }) }); }

  function renderColumnBuilder() {
    // Using data-attributes for event delegation instead of inline onchange/onclick
    document.getElementById('colBuilder').innerHTML = columnState.map((col, i) => `
      <div class="col-card" data-index="${i}">
        <div class="col-main-content">
          <div class="col-inputs">
            <input type="text" placeholder="Name" value="${col.name}" data-field="name" style="width:160px; flex:none;">
            <select data-field="format" style="width:120px; flex:none;">
              <option value="text" ${col.format === 'text' ? 'selected' : ''}>Text</option>
              <option value="tags" ${col.format === 'tags' ? 'selected' : ''}>Tags</option>
            </select>
            <input type="text" placeholder="AI Instructions" value="${col.instructions}" data-field="instructions" style="flex:1; min-width:200px;">
          </div>
          <div class="tags-input-wrap ${col.format !== 'tags' ? 'hidden' : ''}">
            <input type="text" placeholder="Comma tags..." value="${col.tags}" data-field="tags">
          </div>
        </div>
        <button class="btn-icon" data-action="remove-column">×</button>
      </div>
    `).join('');
  }

  // The functions updateCol, addColumn, and removeColumn have been replaced by
  // more efficient event delegation listeners in the DOMContentLoaded section.
  // This prevents re-rendering the entire list on every change, which improves
  // performance and user experience (e.g., input focus is not lost).

  function renderPresetsDropdown() { document.getElementById('presetSelect').innerHTML = '<option value="">-- Load Preset --</option>' + Object.keys(presetState).map(k => `<option value="${k}">${k}</option>`).join(''); }

  async function doSearch() {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) return;
    resetActionTokens();
    const count = document.getElementById('countSelect').value === 'custom' ? document.getElementById('customCountInput').value : document.getElementById('countSelect').value;

    const schemaProps = { company: "string", industry: "string", competitors: [{ name: "string" }], summary: "string" };
    lastUsedColumns = columnState.filter(c => c.name.trim()).map(c => {
      c._safeKey = c.name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
      schemaProps.competitors[0][c._safeKey] = c.format === 'tags' ? `Array from [${c.tags}]` : "string";
      return c;
    });

    startLog('Researching competitors...'); addLog('Contacting provider...');
    try {
      const data = await apiFetch('/api/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, count, provider: document.getElementById('providerSelect').value, model: document.getElementById('modelSelect').value, prompt: `You are an expert market analyst. Find ${count} direct competitors in the same industry as ${query} targeting the same customer base.`, schema: JSON.stringify(schemaProps) })
      });

      lastResults = data; stopLoading();
      renderResearchResults(data);
    } catch (e) {
      document.getElementById('errorBox').innerHTML = e.message; show('errorBox'); stopLoading();
    }
  }

  function renderResearchResults(data) {
    const resultsContainer = document.getElementById('resultsResearch');
    resultsContainer.innerHTML = ''; // Clear previous results

    // --- Create Header ---
    const header = document.createElement('div');
    header.className = 'results-header fade-in';

    const companyDiv = document.createElement('div');
    const companyName = document.createElement('div');
    companyName.className = 'results-company';
    companyName.textContent = data.company; // Safely set text
    companyDiv.appendChild(companyName);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'export-btn';
    exportBtn.textContent = 'Export ↓';
    exportBtn.addEventListener('click', exportExcelResearch); // Attach event listener

    header.appendChild(companyDiv);
    header.appendChild(exportBtn);

    // --- Create Table ---
    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap fade-in';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');

    // Table Head
    const headerRow = document.createElement('tr');
    ['#', 'Company', ...lastUsedColumns.map(c => c.name)].forEach(text => {
      const th = document.createElement('th');
      th.textContent = text;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    // Table Body
    lastResults.competitors.forEach((c, i) => {
      const tr = document.createElement('tr');
      tr.append(createCell(i + 1), createCell(c.name, true));

      lastUsedColumns.forEach(col => {
        const td = document.createElement('td');
        const val = c[col._safeKey];
        if (Array.isArray(val)) {
          val.forEach(v => td.appendChild(createChip(v)));
        } else {
          td.textContent = val || '—';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.append(thead, tbody);
    tableWrap.appendChild(table);
    resultsContainer.append(header, tableWrap);
  }

  function exportExcelResearch() {
    if (!lastResults || !lastResults.competitors || lastResults.competitors.length === 0) return;

    const headerRow = ['#', 'Company', ...lastUsedColumns.map(col => col.name)];

    const dataRows = lastResults.competitors.map((c, i) => [
      i + 1,
      c.name,
      ...lastUsedColumns.map(col => {
        const val = c[col._safeKey];
        return Array.isArray(val) ? val.join(', ') : (val || '');
      })
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);

    // Auto-size columns slightly
    ws['!cols'] = [{ wch: 4 }, { wch: 25 }, ...lastUsedColumns.map(() => ({ wch: 30 }))];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Competitors');

    const safeFilename = lastResults.company ? lastResults.company.replace(/\s+/g, '-').toLowerCase() : 'data';
    XLSX.writeFile(wb, `competitors-${safeFilename}.xlsx`);
  }

  // ── Tab 2: Verification Logic ─────────────────────────────────────────────────
  let uploadedExcelData = [];
  let lastVerifiedResults = [];
  let excelHeaders = [];
  let verifyColumnKeys = [];
  let verifyTargetCompany = "";

  document.getElementById('excelUpload').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      uploadedExcelData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
      if (uploadedExcelData.length > 0) {
        excelHeaders = Object.keys(uploadedExcelData[0]);
        renderDataPreview();
        renderColumnMapping();
      }
    };
    reader.readAsArrayBuffer(file);
  });

  // Attach listener to update checkboxes when the anchor changes
  document.getElementById('companyColSelect').addEventListener('change', renderVerificationCheckboxes);

  function renderColumnMapping() {
    // 1. Auto-detect the best primary column based on common naming conventions
    const keywordMatches = ['company', 'name', 'competitor', 'organization', 'entity'];
    let bestMatch = excelHeaders[0];

    for (let header of excelHeaders) {
      if (keywordMatches.some(keyword => header.toLowerCase().includes(keyword))) {
        bestMatch = header;
        break;
      }
    }

    // 2. Render dropdown and pre-select the detected match
    document.getElementById('companyColSelect').innerHTML = excelHeaders.map(h =>
      `<option value="${h}" ${h === bestMatch ? 'selected' : ''}>${h}</option>`
    ).join('');

    // 3. Trigger the checkbox rendering
    renderVerificationCheckboxes();
    show('mappingSection');
  }

  function renderVerificationCheckboxes() {
    const selectedAnchor = document.getElementById('companyColSelect').value;

    document.getElementById('verifyColsList').innerHTML = excelHeaders.map(h => {
      const isAnchor = h === selectedAnchor;
      // Disable the anchor column so it cannot be verified/altered
      return `
        <label class="checkbox-label" style="${isAnchor ? 'opacity: 0.5; cursor: not-allowed;' : ''}">
          <input type="checkbox" class="verify-cb" value="${h}" ${isAnchor ? 'disabled' : ''}> 
          ${h} ${isAnchor ? '(Anchor)' : ''}
        </label>
      `;
    }).join('');
  }

  async function doVerify() {
    const BATCH_SIZE = 5; // Optimal for accuracy and rate limits
    const selectionInput = document.getElementById('rowSelectionInput').value;

    // 1. Parse row selection logic
    const selectedIndices = parseRowSelection(selectionInput, uploadedExcelData.length);

    if (selectedIndices.length === 0) {
      alert("No valid rows selected based on your input.");
      return;
    }

    // 2. Filter data for verification
    const filteredData = selectedIndices.map(index => uploadedExcelData[index]);

    // 3. Setup verification parameters
    verifyTargetCompany = document.getElementById('companyColSelect').value;
    verifyColumnKeys = Array.from(document.querySelectorAll('.verify-cb:checked')).map(cb => cb.value);

    const targetCompany = document.getElementById('targetCompanyInput').value.trim();
    const checkCompetitor = document.getElementById('cbVerifyCompetitor').checked;
    const rankCompetitor = document.getElementById('cbRankCompetitor').checked;

    if (!verifyTargetCompany || verifyColumnKeys.length === 0) {
      alert("Select a primary entity column and at least one data column to verify.");
      return;
    }

    // 4. Construct JSON Schema
    const schemaProps = { "entity_name": "string matching input exactly" };
    if (checkCompetitor) {
      schemaProps["is_competitor"] = "boolean";
      schemaProps["competitor_rationale"] = "string";
    }
    if (rankCompetitor) {
      schemaProps["competition_score"] = "number (1 to 10)";
    }

    verifyColumnKeys.forEach(k => {
      const safeKey = k.replace(/[^a-zA-Z0-9]/g, "_");
      schemaProps[`${safeKey}_verified`] = "string";
      schemaProps[`${safeKey}_status`] = "unchanged | corrected | filled";
    });

    const schema = JSON.stringify({ verified_records: [schemaProps] });

    let customPrompt = `Review the provided dataset. Maintain the specific terminology and tagging conventions used in the original data. 
      If a column appears to use a standardized set of tags, ensure all corrections or filled blanks use those exact tags.`;
    if (checkCompetitor || rankCompetitor) {
      customPrompt += `\nAdditionally, evaluate each entity against the target company: "${targetCompany}".`;
      if (rankCompetitor) {
        customPrompt += `\nYou MUST assign a 'competition_score' strictly between 1 and 10, where 10 is the highest threat level.`;
      }
    }

    // 5. Initialize UI and Logs
    lastVerifiedResults = [];
    startLog(`Batch Verifying ${filteredData.length} Rows...`);
    hide('resultsVerify');

    // 5.5 Reset token counters
    resetActionTokens();

    // 6. Batch Processing Loop
    resetActionTokens();

    for (let i = 0; i < filteredData.length; i += BATCH_SIZE) {
      const chunk = filteredData.slice(i, i + BATCH_SIZE);
      const progress = Math.round(((i + chunk.length) / filteredData.length) * 100);

      addLog(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${progress}% complete)...`);

      const inputData = chunk.map(row => {
        let obj = { [verifyTargetCompany]: row[verifyTargetCompany] };
        verifyColumnKeys.forEach(k => obj[k] = row[k]);
        return obj;
      });

      try {
        const data = await apiFetch('/api/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: document.getElementById('providerSelect').value,
            model: document.getElementById('modelSelect').value,
            prompt: customPrompt,
            schema: schema,
            input_data: JSON.stringify(inputData)
          })
        });

        lastVerifiedResults = lastVerifiedResults.concat(data.verified_records);
        renderVerifyResults(lastVerifiedResults);

      } catch (e) {
        document.getElementById('errorBox').innerHTML = `Error in batch starting at row ${i + 1}: ${e.message}`;
        show('errorBox');
        console.error("Verification failed:", e);
        break;
      }
    }

    stopLoading();
  }

  function renderVerifyResults(records) {
    if (!records || records.length === 0) return;

    const checkComp = document.getElementById('cbVerifyCompetitor').checked;
    const rankComp = document.getElementById('cbRankCompetitor').checked;

    // Optional: Sort by threat score if that feature is active
    if (rankComp) records.sort((a, b) => (b.competition_score || 0) - (a.competition_score || 0));

    let ths = `<th>Entity</th>`;
    if (checkComp) ths += `<th>Status</th>`;
    if (rankComp) ths += `<th>Threat Score</th>`;
    verifyColumnKeys.forEach(k => { ths += `<th>${k} (Verified)</th>`; });

    const rowsHtml = records.map(rec => {
      let tds = `<td><div class="results-company" style="font-size:15px; margin:0;">${rec.entity_name}</div></td>`;

      if (checkComp) {
        const badgeClass = rec.is_competitor ? 'status-corrected' : 'status-unchanged';
        tds += `<td><span class="status-badge ${badgeClass}">${rec.is_competitor ? 'COMPETITOR' : 'NOT COMPETITOR'}</span></td>`;
      }

      if (rankComp) {
        // Ensure the score is a number and clamp it between 0 and 10
        let score = parseFloat(rec.competition_score) || 0;
        let clampedScore = Math.min(Math.max(score, 0), 10);

        // Display with one decimal point for precision (e.g., 8.5/10)
        tds += `<td><div style="font-size: 15px;"><b>${clampedScore.toFixed(1)}</b><span style="color:#888; font-size:12px;">/10</span></div></td>`;
      }

      verifyColumnKeys.forEach(k => {
        const safeKey = k.replace(/[^a-zA-Z0-9]/g, "_");
        const stat = rec[`${safeKey}_status`];
        tds += `<td><div style="margin-bottom:4px;">${rec[`${safeKey}_verified`] || '—'}</div>
                <span class="status-badge status-${stat || 'unchanged'}">${stat || 'unchanged'}</span></td>`;
      });
      return `<tr>${tds}</tr>`;
    }).join('');

    document.getElementById('resultsVerify').innerHTML = `
      <div class="results-header fade-in">
        <div class="results-company">Verified (${records.length}/${uploadedExcelData.length})</div>
        <button class="export-btn" onclick="exportExcelVerify()">Export ↓</button>
      </div>
      <div class="table-wrap fade-in"><table><thead><tr>${ths}</tr></thead><tbody>${rowsHtml}</tbody></table></div>
    `;
    show('resultsVerify');
  }

  function exportExcelVerify() {
    if (!lastVerifiedResults || lastVerifiedResults.length === 0) return;

    const checkCompetitor = document.getElementById('cbVerifyCompetitor').checked;
    const rankCompetitor = document.getElementById('cbRankCompetitor').checked;

    const headerRow = ['Entity'];
    if (checkCompetitor) { headerRow.push('Competitor Status', 'Rationale'); }
    if (rankCompetitor) { headerRow.push('Threat Score'); }

    verifyColumnKeys.forEach(k => {
      headerRow.push(`${k} (Verified)`);
      headerRow.push(`${k} (Change Status)`);
    });

    const dataRows = lastVerifiedResults.map(rec => {
      const row = [rec.entity_name];

      if (checkCompetitor) {
        row.push(rec.is_competitor ? 'COMPETITOR' : 'NOT COMPETITOR');
        row.push(rec.competitor_rationale || '');
      }
      if (rankCompetitor) {
        let score = parseFloat(rec.competition_score) || 0;
        row.push(Math.min(Math.max(score, 0), 10).toFixed(1));
      }

      verifyColumnKeys.forEach(k => {
        const safeKey = k.replace(/[^a-zA-Z0-9]/g, "_");
        row.push(rec[`${safeKey}_verified`] || '');
        row.push(rec[`${safeKey}_status`] || 'unchanged');
      });

      return row;
    });

    const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);

    const colWidths = [{ wch: 25 }];
    if (checkCompetitor) colWidths.push({ wch: 18 }, { wch: 45 });
    if (rankCompetitor) colWidths.push({ wch: 15 });
    verifyColumnKeys.forEach(() => colWidths.push({ wch: 35 }, { wch: 15 }));
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Verified Data');

    const safeTarget = verifyTargetCompany ? verifyTargetCompany.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() : 'data';
    XLSX.writeFile(wb, `verified-${safeTarget}.xlsx`);
  }

  // Fetch stored comparisons on load and populate the dashboard dropdown
  async function loadStoredComparisons() {
    try {
      const res = await fetch('/api/comparisons');
      if (res.ok) {
        storedComparisons = await res.json();
        renderDashboardDropdown();
      }
    } catch (e) { console.error("Failed to load comparisons"); }
  }

  document.addEventListener('DOMContentLoaded', loadStoredComparisons);

  // ── Dashboard Logic ────────────────────────────────────────────────────────
  let trendChartInstance = null;
  let currentCompanyEvents = [];
  let activeEventIds = new Set();

  function renderDashboardDropdown() {
    const select = document.getElementById('dashboardCompanySelect');
    const companies = Object.keys(storedComparisons).sort();

    select.innerHTML = '<option value="">-- Select a Company --</option>' +
      companies.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  function renderCompanyDashboard(company) {
    const container = document.getElementById('dashboardContent');
    if (!company || !storedComparisons[company] || storedComparisons[company].length === 0) {
      container.classList.add('hidden');
      return;
    }

    // Sort the event data chronologically
    currentCompanyEvents = storedComparisons[company].sort((a, b) => a.timestamp - b.timestamp);

    // Set all data points to active by default
    activeEventIds = new Set(currentCompanyEvents.map(e => e.id));

    container.classList.remove('hidden');

    renderTrendChart(company);
    renderAggregatedTrends();
  }

  function renderTrendChart(company) {
    const ctx = document.getElementById('trendChart').getContext('2d');
    if (trendChartInstance) trendChartInstance.destroy();

    const labels = currentCompanyEvents.map(e => {
      const d = new Date(e.timestamp * 1000);
      return `${d.toLocaleDateString()} vs ${e.opponent_name}`;
    });

    const dataPoints = currentCompanyEvents.map(e => e.net_score);
    const pointColors = currentCompanyEvents.map(e => activeEventIds.has(e.id) ? '#ff1400' : '#cccccc');
    const pointRadii = currentCompanyEvents.map(e => activeEventIds.has(e.id) ? 6 : 4);

    trendChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Net Advantage Score',
          data: dataPoints,
          borderColor: '#111',
          borderWidth: 2,
          pointBackgroundColor: pointColors,
          pointBorderColor: '#fff',
          pointRadius: pointRadii,
          pointHoverRadius: 8,
          fill: false,
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (event, elements) => {
          if (elements.length > 0) {
            const index = elements[0].index;
            const clickedEvent = currentCompanyEvents[index];

            // Toggle the active state of the clicked event
            activeEventIds.has(clickedEvent.id) ? activeEventIds.delete(clickedEvent.id) : activeEventIds.add(clickedEvent.id);

            // Visually update the chart points
            trendChartInstance.data.datasets[0].pointBackgroundColor = currentCompanyEvents.map(e => activeEventIds.has(e.id) ? '#ff1400' : '#cccccc');
            trendChartInstance.data.datasets[0].pointRadius = currentCompanyEvents.map(e => activeEventIds.has(e.id) ? 6 : 4);
            trendChartInstance.update();

            // Recalculate the trends immediately
            renderAggregatedTrends();
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: function (context) {
                const ev = currentCompanyEvents[context.dataIndex];
                return `Net Score: ${ev.net_score} (vs ${ev.opponent_name})`;
              }
            }
          }
        },
        scales: {
          y: { title: { display: true, text: 'Net Score' } }
        }
      }
    });
  }

  function renderAggregatedTrends() {
    const activeEvents = currentCompanyEvents.filter(e => activeEventIds.has(e.id));

    if (activeEvents.length === 0) {
      document.getElementById('aggregatedTrendsContent').innerHTML = '<div style="padding: 20px; color: #888;">No data points selected. Click points on the graph to include them in the summary.</div>';
      document.getElementById('generateSummaryBtn').style.display = 'none';
      return;
    }

    document.getElementById('generateSummaryBtn').style.display = 'block';
    const posMap = {}; const landMap = {};

    // Calculate frequency and sum scores for active events
    activeEvents.forEach(ev => {
      (ev.data || []).forEach(cat => {
        (cat.positives || []).forEach(p => {
          const kw = p.keyword.toLowerCase().trim();
          if (!posMap[kw]) posMap[kw] = { keyword: p.keyword, totalScore: 0, count: 0 };
          posMap[kw].totalScore += parseInt(p.impact_score || 0);
          posMap[kw].count += 1;
        });

        (cat.landmines || []).forEach(l => {
          const kw = l.keyword.toLowerCase().trim();
          if (!landMap[kw]) landMap[kw] = { keyword: l.keyword, totalScore: 0, count: 0 };
          landMap[kw].totalScore += parseInt(l.severity_score || 0);
          landMap[kw].count += 1;
        });
      });
    });

    // Compute averages and sort by highest occurrence/impact
    const topPositives = Object.values(posMap).map(p => ({
      ...p, avgScore: (p.totalScore / p.count).toFixed(1)
    })).sort((a, b) => (b.count * b.avgScore) - (a.count * a.avgScore)).slice(0, 5);

    const topLandmines = Object.values(landMap).map(l => ({
      ...l, avgScore: (l.totalScore / l.count).toFixed(1)
    })).sort((a, b) => (b.count * a.avgScore) - (a.count * a.avgScore)).slice(0, 5);

    // Render the top 5 traits
    document.getElementById('aggregatedTrendsContent').innerHTML = `
        <div style="flex: 1; min-width: 250px; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 8px;">
          <h4 style="color: #16a34a; margin-bottom: 12px; font-size: 14px;">Top Strengths (Aggregated)</h4>
          <ul style="list-style: none; padding: 0; margin: 0;">
            ${topPositives.map(p => `
              <li style="margin-bottom: 10px; display: flex; gap: 8px; align-items: flex-start;">
                <span style="color: #16a34a; font-size: 16px;">•</span>
                <div>
                  <div style="font-weight: 700; color: #16a34a; font-size: 14px;">${p.keyword}</div>
                  <div style="font-size: 12px; color: #555;">Appears in ${p.count} comparison(s) • Avg Impact: ${p.avgScore}/10</div>
                </div>
              </li>
            `).join('') || '<div style="font-size:13px; color:#888;">No positive trends identified.</div>'}
          </ul>
        </div>

        <div style="flex: 1; min-width: 250px; background: #fff0f0; border: 1px solid #ffb3aa; padding: 16px; border-radius: 8px;">
          <h4 style="color: #cc1000; margin-bottom: 12px; font-size: 14px;">Top Landmines (Aggregated)</h4>
          <ul style="list-style: none; padding: 0; margin: 0;">
            ${topLandmines.map(l => `
              <li style="margin-bottom: 10px; display: flex; gap: 8px; align-items: flex-start;">
                <span style="color: #cc1000; font-size: 16px;">•</span>
                <div>
                  <div style="font-weight: 700; color: #cc1000; font-size: 14px;">${l.keyword}</div>
                  <div style="font-size: 12px; color: #555;">Appears in ${l.count} comparison(s) • Avg Severity: ${l.avgScore}/5</div>
                </div>
              </li>
            `).join('') || '<div style="font-size:13px; color:#888;">No negative trends identified.</div>'}
          </ul>
        </div>
      `;
  }

  async function generateExecutiveSummary() {
    const company = document.getElementById('dashboardCompanySelect').value;
    const trendsHtml = document.getElementById('aggregatedTrendsContent').innerText;

    const btn = document.getElementById('generateSummaryBtn');
    btn.innerText = "⏳ Generating...";
    btn.disabled = true;

    try {
      const data = await apiFetch('/api/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: document.getElementById('providerSelect').value,
          model: document.getElementById('modelSelect').value,
          company: company,
          trends: trendsHtml
        })
      });

      renderSummaryUI(data);
    } catch (e) {
      alert("Failed to generate summary: " + e.message);
    } finally {
      btn.innerText = "✨ Generate Executive Summary";
      btn.disabled = false;
    }
  }

  function renderSummaryUI(data) {
    const container = document.getElementById('aggregatedTrendsContent');

    const chooseHtml = (data.reasons_to_choose || []).map(q => `<li style="margin-bottom:8px; display: flex; gap: 8px;"><span style="color: #16a34a;">•</span> <span>${q}</span></li>`).join('');
    const hesitateHtml = (data.reasons_to_hesitate || []).map(q => `<li style="margin-bottom:8px; display: flex; gap: 8px;"><span style="color: #cc1000;">•</span> <span>${q}</span></li>`).join('');

    const summaryHtml = `
        <div style="width: 100%; background: #111; color: #fff; padding: 20px; border-radius: 8px; margin-bottom: 16px;">
          <h3 style="color: #fff; margin-bottom: 8px; font-size: 16px;">Market Positioning</h3>
          <p style="font-size: 14px; line-height: 1.5; color: #ddd;">${data.market_positioning}</p>
        </div>
        <div style="display: flex; gap: 24px; width: 100%; margin-bottom: 24px;">
          <div style="flex: 1; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 8px;">
            <h4 style="margin-bottom: 12px; font-size: 14px; color: #16a34a;">Why Choose Them</h4>
            <ul style="list-style: none; padding: 0; font-size: 13px; color: #444;">${chooseHtml}</ul>
          </div>
          <div style="flex: 1; background: #fff0f0; border: 1px solid #ffb3aa; padding: 16px; border-radius: 8px;">
            <h4 style="margin-bottom: 12px; font-size: 14px; color: #cc1000;">Why Hesitate</h4>
            <ul style="list-style: none; padding: 0; font-size: 13px; color: #444;">${hesitateHtml}</ul>
          </div>
        </div>
      `;

    // Prepend the new AI summary above the raw keyword trends
    container.innerHTML = summaryHtml + container.innerHTML;
  }

  // ── Startup ───────────────────────────────────────────────────────────────────
  function toggleAdvanced() { document.getElementById('advancedSection').classList.toggle('hidden'); }

  function renderDataPreview() {
    const previewContainer = document.getElementById('dataPreviewContainer');
    if (!uploadedExcelData || uploadedExcelData.length === 0) return;

    const previewData = uploadedExcelData.slice(0, 5);

    const ths = excelHeaders.map(h => `<th>${h}</th>`).join('');
    const rows = previewData.map(row => {
      const tds = excelHeaders.map(h => `<td>${row[h] !== undefined ? row[h] : ''}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');

    previewContainer.innerHTML = `
      <div class="table-wrap fade-in" style="max-height: 250px; overflow-x: auto;">
        <table style="white-space: nowrap; min-width: 100%;">
          <thead><tr>${ths}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="font-size: 12px; color: #888; margin-top: 10px;">
        Showing first ${previewData.length} rows out of ${uploadedExcelData.length} total rows.
      </div>
    `;
    show('dataPreviewSection');
  }

  function parseRowSelection(input, maxRows) {
    if (!input || input.trim() === "") {
      // Return all indices if blank
      return Array.from({ length: maxRows }, (_, i) => i);
    }

    const indices = new Set();
    const exclusions = new Set();
    const parts = input.split(',').map(p => p.trim());

    parts.forEach(part => {
      let isExclusion = part.startsWith('!');
      let cleanPart = isExclusion ? part.substring(1) : part;

      if (cleanPart.includes('-')) {
        const [start, end] = cleanPart.split('-').map(Number);
        for (let i = start; i <= end; i++) {
          if (i >= 1 && i <= maxRows) {
            isExclusion ? exclusions.add(i - 1) : indices.add(i - 1);
          }
        }
      } else {
        const num = Number(cleanPart);
        if (!isNaN(num) && num >= 1 && num <= maxRows) {
          isExclusion ? exclusions.add(num - 1) : indices.add(num - 1);
        }
      }
    });

    // If no positive indices were added (e.g., user only typed exclusions), 
    // start with all rows and then remove exclusions.
    const finalIndices = indices.size === 0
      ? Array.from({ length: maxRows }, (_, i) => i)
      : Array.from(indices);

    return finalIndices.filter(i => !exclusions.has(i));
  }
  // ── Tab 3: Comparison Logic ─────────────────────────────────────────────────
  let compareCategories = [
    { id: 1, name: "Pricing", prompt: "Compare their pricing tiers, transparency, and overall value for money.", expanded: false },
    { id: 2, name: "Core Features", prompt: "Compare their primary capabilities and identify any unique selling points (USPs) each has over the other.", expanded: false }
  ];

  function renderCompareCategories() {
    document.getElementById('compareColBuilder').innerHTML = compareCategories.map((cat, i) => `
      <div class="compare-card" data-index="${i}">
        <div class="compare-header">
          <input type="text" placeholder="Category Name" value="${cat.name}" data-field="name">
          <button class="btn-expand" data-action="toggle-prompt" title="Edit Prompt">${cat.expanded ? '▲' : '▼'}</button>
          <button class="btn-icon" data-action="remove-category">×</button>
        </div>
        <div class="compare-body ${cat.expanded ? 'expanded' : ''}">
          <div class="provider-label" style="margin-bottom: 4px;">Custom Instructions / Prompt</div>
          <textarea data-field="prompt" placeholder="Specific instructions for this category...">${cat.prompt}</textarea>
        </div>
      </div>
    `).join('');
  }


  function updateCompareCat(i, field, value) { compareCategories[i][field] = value; if (field !== 'expanded') renderCompareCategories(); }

  // Main comparison function
  let currentCompareData = null;

  async function doCompare() {
    const compA = document.getElementById('compAInput').value.trim();
    const compB = document.getElementById('compBInput').value.trim();

    if (!compA || !compB) return alert("Please enter both Company A and Company B.");
    const activeCats = compareCategories.filter(c => c.name.trim());
    if (activeCats.length === 0) return alert("Add at least one comparison category.");

    startLog(`Analyzing strategic positioning: ${compA} vs ${compB}...`);

    const schemaProps = {
      "categories": [{
        "category_name": "string",
        "comp_A_positives": [{ "keyword": "string (Max 3 words)", "impact_score": "integer (1 to 10)", "search_query": "string (Specific Google search query)" }],
        "comp_B_positives": [{ "keyword": "string (Max 3 words)", "impact_score": "integer (1 to 10)", "search_query": "string (Specific Google search query)" }],
        "comp_A_landmines": [{ "keyword": "string (Max 3 words)", "severity_score": "integer (1 to 5)", "search_query": "string (Specific Google search query)" }],
        "comp_B_landmines": [{ "keyword": "string (Max 3 words)", "severity_score": "integer (1 to 5)", "search_query": "string (Specific Google search query)" }]
      }]
    };

    let customPrompt = `Act as a B2B competitive intelligence strategist. Perform an asymmetric analysis between ${compA} and ${compB}.\n`;
    customPrompt += `Assign positives an impact score from 1 to 10. Assign landmines a severity score from 1 to 5 (the system will automatically convert these to negative penalties).\n`;
    customPrompt += `Instead of URLs, provide a 'search_query' that a human could type into Google to verify your claim. Use strictly short keywords (max 3 words).\n\n`;
    activeCats.forEach(c => customPrompt += `- Category: ${c.name} (Instructions: ${c.prompt})\n`);

    hide('resultsCompare');

    try {
      const data = await apiFetch('/api/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: document.getElementById('providerSelect').value,
          model: document.getElementById('modelSelect').value,
          prompt: customPrompt,
          schema: JSON.stringify(schemaProps)
        })
      });

      currentCompareData = data;
      stopLoading();
      renderInteractiveCompare(compA, compB);

      // Continue saving to local storage in the background for the future Battlecard feature
      const payload = {};
      payload[compA] = data.categories.map(c => ({ category: c.category_name, positives: c.comp_A_positives, landmines: c.comp_A_landmines }));
      payload[compB] = data.categories.map(c => ({ category: c.category_name, positives: c.comp_B_positives, landmines: c.comp_B_landmines }));

      await fetch('/api/comparisons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      loadStoredComparisons();

    } catch (e) {
      document.getElementById('errorBox').innerHTML = e.message; show('errorBox'); stopLoading();
    }
  }

  function renderInteractiveCompare(compA, compB) {
    if (!currentCompareData || !currentCompareData.categories) return;
    const resultsDiv = document.getElementById('resultsCompare');
    resultsDiv.innerHTML = ''; // Clear previous results

    // --- Create Total Score Banner ---
    const banner = document.createElement('div');
    banner.className = 'total-score-banner fade-in';
    banner.innerHTML = `
            <div><div style="font-size: 13px; color: #888; text-transform: uppercase;"></div><div class="score-display" id="totalScoreA">0</div></div>
            <div style="font-size: 20px; font-weight: 800; color: #555;">VS</div>
            <div style="text-align: right;"><div style="font-size: 13px; color: #888; text-transform: uppercase;"></div><div class="score-display" id="totalScoreB">0</div></div>
        `;
    banner.children[0].children[0].textContent = `${compA} Total Advantage`;
    banner.children[2].children[0].textContent = `${compB} Total Advantage`;
    resultsDiv.appendChild(banner);

    // --- Create Category Cards ---
    currentCompareData.categories.forEach((cat, catIndex) => {
      const card = document.createElement('div');
      card.className = 'score-card fade-in';

      // Helper to render a list of attributes (positives/landmines)
      const renderList = (items, companyKey, isPositive) => {
        const ul = document.createElement('ul');
        ul.style.cssText = 'list-style: none; padding: 0; margin: 0;';

        (items || []).forEach(attr => {
          const rawScore = attr.impact_score || attr.severity_score || 1;
          const score = isPositive ? Math.abs(rawScore) : -Math.abs(rawScore);
          const query = encodeURIComponent(attr.search_query || `${attr.keyword} ${companyKey === 'A' ? compA : compB}`);

          const li = document.createElement('li');
          li.style.marginBottom = '8px';
          li.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="color: ${isPositive ? '#16a34a' : '#cc1000'}; font-size: 16px;">•</span>
                                <span class="keyword" style="font-weight: 700; color: ${isPositive ? '#16a34a' : '#cc1000'}; font-size: 14px;"></span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <a class="verify-link" href="https://www.google.com/search?q=${query}" target="_blank" style="font-size: 11px; color: #0284c7; text-decoration: none;">[Verify]</a>
                            </div>
                        </div>`;
          li.querySelector('.keyword').textContent = attr.keyword; // Safe insertion

          const input = document.createElement('input');
          input.type = 'number';
          input.className = `point-input ${isPositive ? 'positive' : 'negative'}`;
          input.style.cssText = `width: 44px; padding: 2px 4px; font-size: 12px; border-radius: 4px; text-align: center; border: 1px solid ${isPositive ? '#bbf7d0' : '#ffb3aa'};`;
          input.value = score;
          input.dataset.company = companyKey; // 'A' or 'B'

          li.querySelector('.verify-link').parentElement.appendChild(input);
          ul.appendChild(li);
        });
        return ul;
      };

      const header = document.createElement('div');
      header.className = 'score-card-header';
      header.dataset.action = 'toggle-card';
      header.innerHTML = `
                <div style="display: flex; flex-direction: column;">
                    <div class="cat-title"></div>
                    <div class="cat-total" style="font-size: 12px; font-weight: 600; color: #555; margin-top: 4px;">Category Score: Calculating...</div>
                </div>
                <div style="font-size: 20px; color: #ccc;">↕</div>`;
      header.querySelector('.cat-title').textContent = cat.category_name;

      const body = document.createElement('div');
      body.className = 'score-card-body';
      body.style.flexDirection = 'column';

      const positivesRow = document.createElement('div');
      positivesRow.style.cssText = 'display: flex; gap: 24px; width: 100%;';
      positivesRow.innerHTML = `
                <div style="flex: 1; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 8px;"><h4 class="comp-a-title" style="color: #16a34a; margin-bottom: 12px; font-size: 14px;"></h4></div>
                <div style="flex: 1; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 8px;"><h4 class="comp-b-title" style="color: #16a34a; margin-bottom: 12px; font-size: 14px;"></h4></div>`;
      positivesRow.querySelector('.comp-a-title').textContent = `What ${compA} Can Emphasize`;
      positivesRow.querySelector('.comp-b-title').textContent = `What ${compB} Can Emphasize`;
      positivesRow.children[0].appendChild(renderList(cat.comp_A_positives, 'A', true));
      positivesRow.children[1].appendChild(renderList(cat.comp_B_positives, 'B', true));

      const landminesRow = document.createElement('div');
      landminesRow.style.cssText = 'display: flex; gap: 24px; width: 100%; margin-top: 16px;';
      landminesRow.innerHTML = `
                <div style="flex: 1; background: #fff0f0; border: 1px solid #ffb3aa; padding: 16px; border-radius: 8px;"><h4 class="comp-a-landmine-title" style="color: #cc1000; margin-bottom: 12px; font-size: 14px;"></h4></div>
                <div style="flex: 1; background: #fff0f0; border: 1px solid #ffb3aa; padding: 16px; border-radius: 8px;"><h4 class="comp-b-landmine-title" style="color: #cc1000; margin-bottom: 12px; font-size: 14px;"></h4></div>`;
      landminesRow.querySelector('.comp-a-landmine-title').textContent = `Landmines for ${compA}`;
      landminesRow.querySelector('.comp-b-landmine-title').textContent = `Landmines for ${compB}`;
      landminesRow.children[0].appendChild(renderList(cat.comp_A_landmines, 'A', false));
      landminesRow.children[1].appendChild(renderList(cat.comp_B_landmines, 'B', false));

      body.appendChild(positivesRow);
      body.appendChild(landminesRow);
      card.appendChild(header);
      card.appendChild(body);
      resultsDiv.appendChild(card);
    });

    show('resultsCompare');
    recalculateScores();
  }

  function recalculateScores() {
    let globalScoreA = 0;
    let globalScoreB = 0;

    const categoryCards = document.querySelectorAll('#resultsCompare .score-card');
    categoryCards.forEach(card => {
      let catScoreA = 0;
      let catScoreB = 0;

      card.querySelectorAll('.point-input').forEach(input => {
        const score = parseInt(input.value, 10) || 0;
        if (input.dataset.company === 'A') {
          catScoreA += score;
        } else if (input.dataset.company === 'B') {
          catScoreB += score;
        }
      });

      const catHeader = card.querySelector('.cat-total');
      if (catHeader) {
        catHeader.innerHTML = `Category Score: <span style="color:${catScoreA >= 0 ? '#16a34a' : '#cc1000'}">${catScoreA}</span> vs <span style="color:${catScoreB >= 0 ? '#16a34a' : '#cc1000'}">${catScoreB}</span>`;
      }

      globalScoreA += catScoreA;
      globalScoreB += catScoreB;
    });

    document.getElementById('totalScoreA').textContent = globalScoreA;
    document.getElementById('totalScoreB').textContent = globalScoreB;
  }
  // ── Token Tracking Widget Logic ───────────────────────────────────────────────
  let sessionTokens = 0;
  let lastActionTokens = 0;

  function updateProgress(percent, text) {
    const bar = document.getElementById('loadingProgress');
    const status = document.getElementById('loadingStatusText');
    if (bar) bar.style.width = percent + '%';
    if (status) status.innerText = text;
  }

  // Global fetch wrapper for automatic token and progress tracking
  async function apiFetch(url, options) {
    updateProgress(10, "Transmitting request to server...");

    // Simulate progress during the network blackout period
    let simProgress = 15;
    const simInterval = setInterval(() => {
      if (simProgress < 75) {
        simProgress += 2;
        updateProgress(simProgress, "Awaiting AI generation...");
      }
    }, 1000);

    try {
      const res = await fetch(url, options);
      clearInterval(simInterval);
      updateProgress(80, "Response received, parsing data...");

      const data = await res.json();

      if (data._meta_usage) {
        sessionTokens += data._meta_usage;
        lastActionTokens += data._meta_usage;
        updateTokenWidget();
      }

      if (!res.ok) throw new Error(data.error || "API Error");

      updateProgress(100, "Rendering interface...");
      return data;
    } catch (err) {
      clearInterval(simInterval);
      updateProgress(0, "Process failed.");
      throw err;
    }
  }

  function resetActionTokens() {
    lastActionTokens = 0;
    updateTokenWidget();
  }

  function addTokens(amount) {
    sessionTokens += amount;
    lastActionTokens += amount;
    updateTokenWidget();
  }

  function updateTokenWidget() {
    const select = document.getElementById('modelSelect');
    const modelLabel = select.options[select.selectedIndex]?.text || '...';
    // Extract just the brand and tier (e.g., "Claude Sonnet" or "GPT-4o")
    const shortName = modelLabel.replace(/\s\([\d-]+\)/, '');

    document.getElementById('twModel').innerText = shortName;
    document.getElementById('twLast').innerText = lastActionTokens.toLocaleString();
    document.getElementById('twTotal').innerText = sessionTokens.toLocaleString();
  }

  // Bind the widget update to dropdown changes
  document.getElementById('modelSelect').addEventListener('change', updateTokenWidget);
  // Run once on load after models are fetched
  document.addEventListener('DOMContentLoaded', () => { // --- Global Event Listeners ---
    // Tab navigation
    document.querySelector('.tabs-nav').addEventListener('click', (e) => {
      const tabButton = e.target.closest('.tab-btn');
      if (tabButton && tabButton.dataset.tab) {
        switchTab(tabButton.dataset.tab);
      }
    });

    // Main search button and enter key
    document.getElementById('searchBtn').addEventListener('click', doSearch);
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    // Event Delegation for Column Builder
    document.getElementById('addColumnBtn').addEventListener('click', () => {
      columnState.push({ id: Date.now(), name: "", format: "text", instructions: "", tags: "" });
      renderColumnBuilder();
      persistSettings();
    });

    const colBuilder = document.getElementById('colBuilder');
    colBuilder.addEventListener('input', (e) => {
      const input = e.target.closest('input[data-field], select[data-field]');
      if (!input) return;

      const card = input.closest('.col-card');
      const index = parseInt(card.dataset.index, 10);
      const field = input.dataset.field;

      if (!isNaN(index) && field) {
        columnState[index][field] = input.value;
        persistSettings();
        if (field === 'format') {
          card.querySelector('.tags-input-wrap').classList.toggle('hidden', input.value !== 'tags');
        }
      }
    });
    colBuilder.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('button[data-action="remove-column"]');
      if (!removeBtn) return;
      const card = removeBtn.closest('.col-card');
      const index = parseInt(card.dataset.index, 10);
      if (!isNaN(index)) {
        columnState.splice(index, 1);
        renderColumnBuilder();
        persistSettings();
      }
    });

    // Event Delegation for Compare Categories
    const compareBuilder = document.getElementById('compareColBuilder').parentElement;
    compareBuilder.addEventListener('click', e => {
      const addBtn = e.target.closest('button[data-action="add-category"]');
      const removeBtn = e.target.closest('button[data-action="remove-category"]');
      const toggleBtn = e.target.closest('button[data-action="toggle-prompt"]');

      if (addBtn) { compareCategories.push({ id: Date.now(), name: "", prompt: "", expanded: true }); renderCompareCategories(); }
      else if (removeBtn) { const i = parseInt(removeBtn.closest('.compare-card').dataset.index, 10); if (!isNaN(i)) { compareCategories.splice(i, 1); renderCompareCategories(); } }
      else if (toggleBtn) { const card = toggleBtn.closest('.compare-card'); const i = parseInt(card.dataset.index, 10); if (!isNaN(i)) { compareCategories[i].expanded = !compareCategories[i].expanded; card.querySelector('.compare-body').classList.toggle('expanded'); toggleBtn.textContent = compareCategories[i].expanded ? '▲' : '▼'; } }
    });
    compareBuilder.addEventListener('input', e => {
      const input = e.target.closest('input[data-field], textarea[data-field]');
      if (!input) return;
      const i = parseInt(input.closest('.compare-card').dataset.index, 10);
      if (!isNaN(i) && input.dataset.field) { compareCategories[i][input.dataset.field] = input.value; }
    });

    // Event Delegation for Interactive Compare Results
    const compareResults = document.getElementById('resultsCompare');
    compareResults.addEventListener('change', (e) => { if (e.target.classList.contains('point-input')) { recalculateScores(); } });
    compareResults.addEventListener('click', (e) => {
      const header = e.target.closest('.score-card-header[data-action="toggle-card"]');
      if (header) { header.closest('.score-card').classList.toggle('open'); }
    });

    // Help Popover Event Delegation
    document.body.addEventListener('mouseover', e => {
      const helpIcon = e.target.closest('.help-icon-wrap');
      if (helpIcon && helpIcon.id) {
        const baseId = helpIcon.id.replace('Icon', '');
        showHelp(baseId);
      }
    });

    document.body.addEventListener('mouseout', e => {
      const helpIcon = e.target.closest('.help-icon-wrap');
      if (helpIcon && helpIcon.id) {
        const baseId = helpIcon.id.replace('Icon', '');
        hideHelp(baseId);
      }
    });

    document.body.addEventListener('click', e => {
      const helpIcon = e.target.closest('.help-icon-wrap');
      if (helpIcon && helpIcon.id) {
        const baseId = helpIcon.id.replace('Icon', '');
        toggleHelp(baseId);
      }
    });

    // Event Listener for Dashboard Company Select
    document.getElementById('dashboardCompanySelect').addEventListener('change', (e) => {
      renderCompanyDashboard(e.target.value);
    });

    // Admin Panel
    document.getElementById('unlockAdminBtn').addEventListener('click', () => { isAdminAuthenticated ? lockAdminPanel() : unlockAdminPanel(); });
    document.getElementById('saveApiKeysBtn').addEventListener('click', saveApiKeys);
    document.getElementById('deleteAllComparisonsBtn').addEventListener('click', deleteAllComparisons);
    document.getElementById('deleteOpenAIKeyBtn').addEventListener('click', () => deleteApiKey('openai'));
    document.getElementById('deleteAnthropicKeyBtn').addEventListener('click', () => deleteApiKey('anthropic'));

    // Settings Tab
    document.getElementById('providerSelect').addEventListener('change', onProviderChange);
    document.getElementById('presetSelect').addEventListener('change', (e) => loadPreset(e.target.value));
    document.getElementById('savePresetBtn').addEventListener('click', saveCurrentAsPreset);
    document.getElementById('deletePresetBtn').addEventListener('click', deletePreset);

    // Research Tab
    document.getElementById('countSelect').addEventListener('change', toggleCustomCount);
    document.getElementById('advancedToggle').addEventListener('click', toggleAdvanced);

    // Verification Tab
    document.getElementById('verifyBtn').addEventListener('click', doVerify);

    // Compare Tab
    document.getElementById('compareBtn').addEventListener('click', doCompare);

    // Dashboard Tab
    document.getElementById('generateSummaryBtn').addEventListener('click', generateExecutiveSummary);

    // Other initializations
    fetchModels();
    initColumns();
    renderCompareCategories();
    loadStoredComparisons();

    // Move the API key management section into the admin panel.
    // This ensures it's only visible when the admin panel itself is visible.
    const apiKeySection = document.getElementById('apiKeyManagementSection');
    const adminPanel = document.getElementById('adminPanel');
    if (apiKeySection && adminPanel) { adminPanel.prepend(apiKeySection); }

    checkAdminStatusAndRenderButton(); // Check admin status on load
    document.getElementById('customPrompt').value = "You are an expert market analyst. Find {count} direct competitors in the same industry as {query} targeting the same customer base.";
    setTimeout(updateTokenWidget, 1000);
  });
  // These functions were previously called via inline handlers, but are global.
  function toggleCustomCount() { document.getElementById('countSelect').value === 'custom' ? show('customCountInput') : hide('customCountInput'); }
  function toggleAdvanced() { document.getElementById('advancedSection').classList.toggle('hidden'); }

  // ── Admin Panel Logic ────────────────────────────────────────────────────────
  let isAdminAuthenticated = false;

  async function unlockAdminPanel() {
    const passwordInput = document.getElementById('adminPasswordInput');
    const password = passwordInput.value;

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
      });
      const data = await res.json();

      if (res.ok) {
        isAdminAuthenticated = true;
        show('adminPanel');
        passwordInput.value = '';
        passwordInput.placeholder = 'Admin Panel Unlocked';
        passwordInput.disabled = true;
        document.getElementById('unlockAdminBtn').textContent = 'Lock Admin Panel';
        document.getElementById('unlockAdminBtn').classList.add('btn-delete');
        document.getElementById('unlockAdminBtn').disabled = false;
        renderAdminPanel();
        showToast(data.message); // Replaced alert
      } else {
        showToast(data.error || 'Failed to unlock admin panel.', true); // Replaced alert
      }
    } catch (error) {
      console.error('Admin login error:', error);
      showToast('An error occurred during admin login.', true); // Replaced alert
    }
  }

  async function lockAdminPanel() {
    try {
      const res = await fetch('/api/admin/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();

      if (res.ok) {
        isAdminAuthenticated = false;
        hide('adminPanel');
        document.getElementById('adminPasswordInput').value = '';
        document.getElementById('adminPasswordInput').placeholder = 'Admin Password';
        document.getElementById('adminPasswordInput').disabled = false;
        document.getElementById('unlockAdminBtn').textContent = 'Unlock Admin Panel';
        document.getElementById('unlockAdminBtn').classList.remove('btn-delete');
        document.getElementById('unlockAdminBtn').disabled = false;
        showToast(data.message); // Replaced alert
      } else {
        showToast(data.error || 'Failed to lock admin panel.', true); // Replaced alert
      }
    } catch (error) {
      console.error('Admin logout error:', error);
      showToast('An error occurred during admin logout.', true); // Replaced alert
    }
  }

  async function renderAdminPanel() {
    if (!isAdminAuthenticated) {
      // If not admin, we just ensure the panel is hidden.
      hide('adminPanel');
      return;
    }

    // Fetch and display global API key status
    try {
      const keyRes = await fetch('/api/admin/api_keys');
      if (keyRes.ok) {
        const keyData = await keyRes.json();
        const openAIInput = document.getElementById('userOpenAIKeyInput');
        const anthropicInput = document.getElementById('userAnthropicKeyInput');

        openAIInput.placeholder = keyData.openai_key_set ? 'A global OpenAI key is set' : 'Enter global OpenAI API Key';
        anthropicInput.placeholder = keyData.anthropic_key_set ? 'A global Anthropic key is set' : 'Enter global Anthropic API Key';
      }
    } catch (error) {
      console.error('Failed to fetch global API key status:', error);
    }

    // Fetch and display comparisons
    try { // This block should only run if authenticated
      const res = await fetch('/api/admin/comparisons');
      const comparisons = await res.json();
      const tbody = document.querySelector('#adminComparisonsList tbody');
      tbody.innerHTML = ''; // Clear existing

      comparisons.forEach(comp => {
        const tr = document.createElement('tr');
        const date = new Date(comp.timestamp * 1000).toLocaleString();
        tr.innerHTML = `
                    <td>${comp.id}</td>
                    <td>${comp.company_name}</td>
                    <td>${comp.opponent_name}</td>
                    <td>${comp.net_score}</td>
                    <td>${date}</td>
                    <td><button class="btn-icon" data-action="delete-comparison" data-id="${comp.id}">×</button></td>
                `;
        tbody.appendChild(tr);
      });

      tbody.addEventListener('click', async (e) => {
        if (e.target.dataset.action === 'delete-comparison') {
          const id = e.target.dataset.id;
          if (confirm(`Are you sure you want to delete comparison ID ${id}?`)) {
            await deleteComparison(id);
          }
        }
      });

    } catch (error) {
      console.error('Failed to fetch comparisons:', error);
    }
  }

  async function saveApiKeys() {
    const openaiKey = document.getElementById('userOpenAIKeyInput').value;
    const anthropicKey = document.getElementById('userAnthropicKeyInput').value;

    try {
      const res = await fetch('/api/admin/api_keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openai_key: openaiKey, anthropic_key: anthropicKey })
      });
      const data = await res.json();
      alert(data.message);
      renderAdminPanel(); // Refresh placeholders and list
      document.getElementById('userOpenAIKeyInput').value = '';
      document.getElementById('userAnthropicKeyInput').value = '';
    } catch (error) { console.error('Failed to save API keys:', error); alert('Error saving API keys.'); }
  }

  async function deleteApiKey(provider) {
    if (!confirm(`Are you sure you want to delete the global ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key?`)) return;

    try {
      const res = await fetch('/api/admin/api_keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider })
      });
      const data = await res.json();

      if (res.ok) {
        showToast(data.message);
        renderAdminPanel(); // Refresh placeholders
      } else {
        showToast(data.error || 'Failed to delete API key.', true);
      }
    } catch (error) {
      console.error('Failed to delete API key:', error);
      showToast('Error deleting API key.', true);
    }
  }
  
  async function deleteComparison(id) {
    if (!isAdminAuthenticated) return;
    try {
      const res = await fetch('/api/admin/comparisons', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id })
      });
      const data = await res.json();
      alert(data.message);
      renderAdminPanel(); // Refresh list
    } catch (error) { console.error('Failed to delete comparison:', error); alert('Error deleting comparison.'); }
  }

  async function deleteAllComparisons() {
    if (!isAdminAuthenticated) return;
    if (confirm('Are you absolutely sure you want to delete ALL comparison entries? This cannot be undone.')) {
      try {
        const res = await fetch('/api/admin/comparisons', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}) // Empty body to indicate delete all
        });
        const data = await res.json();
        alert(data.message);
        renderAdminPanel(); // Refresh list
      } catch (error) { console.error('Failed to delete all comparisons:', error); alert('Error deleting all comparisons.'); }
    }
  }

  // Function to check admin status and update button/panel visibility on tab switch/load
  async function checkAdminStatusAndRenderButton() {
    try {
      const passwordInput = document.getElementById('adminPasswordInput');
      passwordInput.style.width = '100%';
      passwordInput.style.boxSizing = 'border-box';

      const res = await fetch('/api/admin/comparisons'); // A protected endpoint to check auth
      if (res.ok) {
        isAdminAuthenticated = true;
        show('adminPanel');
        passwordInput.value = '';
        passwordInput.placeholder = 'Admin Panel Unlocked';
        passwordInput.disabled = true;
        document.getElementById('unlockAdminBtn').textContent = 'Lock Admin Panel';
        document.getElementById('unlockAdminBtn').classList.add('btn-delete');
        document.getElementById('unlockAdminBtn').disabled = false; // Re-enable for locking
        renderAdminPanel();
      } else {
        isAdminAuthenticated = false;
        hide('adminPanel');
        document.getElementById('unlockAdminBtn').textContent = 'Unlock Admin Panel';
        document.getElementById('unlockAdminBtn').classList.remove('btn-delete');
        document.getElementById('unlockAdminBtn').disabled = false;
      }
    } catch (error) {
      console.error('Failed to check admin status:', error);
    }
  }

  function showToast(message, isError = false) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${isError ? 'error' : ''}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Automatically remove the toast after 3 seconds
    setTimeout(() => {
      toast.classList.add('fade-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
  }

  // --- Helper functions for safe DOM creation ---
  function createCell(text, isBold = false) {
    const td = document.createElement('td');
    if (isBold) {
      const b = document.createElement('b');
      b.textContent = text;
      td.appendChild(b);
    } else {
      td.textContent = text;
    }
    return td;
  }

  function createChip(text) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = text;
    return chip;
  }

  let storedComparisons = {}; // This is fine inside the IIFE

})(); // End of IIFE