import MDBReader from 'https://esm.sh/mdb-reader@3.2.0?bundle';
import { Buffer } from 'https://esm.sh/buffer@6.0.3?bundle';

globalThis.Buffer = Buffer;

(() => {
  const $ = (s) => document.querySelector(s);
  const status = $('#status');
  const state = { reader: null, tables: [], selected: null, columns: [], hiddenColumns: new Set(), page: 0, pageSize: 100, sourceName: '' };

  function report(message, error = false) {
    status.textContent = message;
    status.className = `status${error ? ' error' : ''}`;
  }

  async function loadBundledDatabase() {
    try {
      report('Reading data/BMSData.accdb…');
      const response = await fetch('/data/BMSData.accdb');
      if (!response.ok) throw new Error('Could not find data/BMSData.accdb. Check that the database is in the project’s data folder.');
      const bytes = await response.arrayBuffer();
      state.reader = new MDBReader(Buffer.from(bytes));
      state.sourceName = 'BMSData.accdb';
      state.tables = state.reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false }).map((name) => {
        const table = state.reader.getTable(name);
        return { name, columns: table.getColumnNames(), count: table.rowCount };
      });
      report(''); showDatabase();
    } catch (err) { report(err.message, true); }
  }

  function formatValue(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Uint8Array) return `[Binary data · ${v.byteLength.toLocaleString()} bytes]`;
    if (Array.isArray(v)) return v.map((item) => item?.name || String(item)).join('; ');
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }

  function showDatabase() {
    $('#uploadView').classList.add('hidden');
    $('#databaseView').classList.remove('hidden');
    $('#dbName').textContent = state.sourceName;
    $('#dbMeta').textContent = `${state.tables.length} ${state.tables.length === 1 ? 'table' : 'tables'} · read from the local data folder`;
    $('#tableCount').textContent = String(state.tables.length).padStart(2, '0');
    drawTableList();
    if (state.tables.length) selectTable(state.tables[0].name);
    else $('#tableContent').innerHTML = '<div class="empty-state"><span>⌕</span><strong>No tables found</strong><small>This file may contain no readable tables.</small></div>';
  }

  function drawTableList() {
    const list = $('#tableList'); list.replaceChildren();
    state.tables.forEach((table) => {
      const button = document.createElement('button');
      button.className = `table-item${state.selected === table.name ? ' selected' : ''}`;
      button.title = table.name;
      button.innerHTML = `<span class="table-glyph">▤</span><span class="table-name"></span><small>${table.count === null ? '—' : table.count}</small>`;
      button.querySelector('.table-name').textContent = table.name;
      button.addEventListener('click', () => selectTable(table.name));
      list.append(button);
    });
  }

  function selectTable(name) {
    state.selected = name; state.page = 0; state.hiddenColumns.clear();
    drawTableList();
    const table = state.tables.find((t) => t.name === name);
    state.columns = table.columns;
    $('#tableTitle').textContent = name;
    $('#recordCount').textContent = `${table.count === null ? '—' : table.count.toLocaleString()} records`;
    $('#exportButton').disabled = false;
    drawFields(); drawRows();
  }

  function drawFields() {
    const bar = $('#fieldBar'); bar.replaceChildren();
    const allWrap = document.createElement('label');
    const all = document.createElement('input'); all.type = 'checkbox'; all.checked = state.hiddenColumns.size === 0; all.setAttribute('aria-label', 'Select all fields');
    all.addEventListener('change', () => { state.hiddenColumns = new Set(all.checked ? [] : state.columns); drawFields(); drawRows(); });
    allWrap.append(all, document.createTextNode('All fields'));
    const chips = document.createElement('div'); chips.className = 'field-chips';
    state.columns.forEach((column) => {
      const chip = document.createElement('button'); chip.className = `field-chip${state.hiddenColumns.has(column) ? ' off' : ''}`; chip.textContent = column; chip.title = `${state.hiddenColumns.has(column) ? 'Include' : 'Exclude'} ${column} in export`;
      chip.addEventListener('click', () => { state.hiddenColumns.has(column) ? state.hiddenColumns.delete(column) : state.hiddenColumns.add(column); drawFields(); drawRows(); }); chips.append(chip);
    });
    bar.append(allWrap, chips);
  }

  function visibleColumns() { return state.columns.filter((c) => !state.hiddenColumns.has(c)); }

  async function drawRows() {
    const cols = visibleColumns();
    const host = $('#tableContent'); host.replaceChildren();
    if (!cols.length) {
      host.innerHTML = '<div class="empty-state"><span>⌕</span><strong>No fields selected</strong><small>Turn on at least one field to preview or export.</small></div>';
      $('#tableFooter').classList.add('hidden'); return;
    }
    host.innerHTML = '<div class="empty-state"><small>Loading records…</small></div>';
    try {
      const tableData = state.reader.getTable(state.selected);
      const records = tableData.getData({ columns: cols, rowOffset: state.page * state.pageSize, rowLimit: state.pageSize });
      const rows = records.map((record) => cols.map((col) => record[col]));
      const total = tableData.rowCount;
      host.replaceChildren();
      if (!rows.length) host.innerHTML = '<div class="empty-state"><span>▤</span><strong>This table is empty</strong><small>You can still export its field headings.</small></div>';
      else {
        const table = document.createElement('table'); table.className = 'data-table';
        const thead = document.createElement('thead'), headRow = document.createElement('tr');
        cols.forEach((col) => { const th = document.createElement('th'); th.textContent = col; headRow.append(th); }); thead.append(headRow); table.append(thead);
        const tbody = document.createElement('tbody');
        rows.forEach((row) => { const tr = document.createElement('tr'); row.forEach((value) => { const td = document.createElement('td'); const txt = formatValue(value); td.textContent = txt || (value === null ? 'NULL' : ''); td.title = txt; if (value === null) td.className = 'null'; tr.append(td); }); tbody.append(tr); });
        table.append(tbody); host.append(table);
      }
      const footer = $('#tableFooter'); footer.classList.remove('hidden'); footer.replaceChildren();
      const label = document.createElement('span'); label.textContent = total ? `Showing ${state.page * state.pageSize + 1}–${Math.min((state.page + 1) * state.pageSize, total)} of ${total.toLocaleString()} records` : '0 records';
      const controls = document.createElement('span');
      if (total > state.pageSize) {
        const prev = document.createElement('button'), next = document.createElement('button');
        [prev, next].forEach((b) => { b.style.cssText = 'border:1px solid #e4e7e0;border-radius:4px;background:#fff;padding:4px 8px;color:#687268;font:10px DM Sans,sans-serif;cursor:pointer;margin-left:5px'; });
        prev.textContent = '← Previous'; next.textContent = 'Next →'; prev.disabled = state.page === 0; next.disabled = (state.page + 1) * state.pageSize >= total;
        prev.addEventListener('click', () => { state.page--; drawRows(); }); next.addEventListener('click', () => { state.page++; drawRows(); }); controls.append(prev, next);
      }
      footer.append(label, controls);
    } catch (err) { host.innerHTML = `<div class="empty-state"><strong>Could not load records</strong><small>${err.message}</small></div>`; }
  }

  async function exportTable() {
    if (!state.selected) return;
    const cols = visibleColumns(); if (!cols.length) { report('Select at least one field before exporting.', true); return; }
    const button = $('#exportButton'); button.disabled = true; button.innerHTML = '<span>…</span> Preparing';
    try {
      const table = state.reader.getTable(state.selected);
      const records = table.getData({ columns: cols });
      const lines = [cols, ...records.map((record) => cols.map((col) => formatValue(record[col])))].map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const blob = new Blob(['\ufeff', lines], { type: 'text/csv;charset=utf-8' });
      const base = `${state.sourceName.replace(/\.(mdb|accdb)$/i, '')}_${state.selected}`.replace(/[\\/:*?"<>|]+/g, '_');
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${base}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      report(`Exported ${records.length.toLocaleString()} records from “${state.selected}”.`);
    } catch (err) { report(`Export failed: ${err.message}`, true); }
    finally { button.disabled = false; button.innerHTML = '<span>↓</span> Export table'; }
  }

  $('#exportButton').addEventListener('click', exportTable);
  const dialog = $('#infoDialog');
  ['helpButton', 'howButton'].forEach((id) => $(`#${id}`).addEventListener('click', () => dialog.showModal()));
  $('#closeDialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  loadBundledDatabase();
})();
