import MDBReader from 'https://esm.sh/mdb-reader@3.2.0?bundle';
import { Buffer } from 'https://esm.sh/buffer@6.0.3?bundle';

globalThis.Buffer = Buffer;

const $ = (selector) => document.querySelector(selector);
const state = { reader: null, tables: [], selected: null, records: [], visible: [], page: 0, pageSize: 100, search: '', sortColumn: null, sortDirection: 1, activeRecord: 0 };
const grid = $('#accessGrid');

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return `[Binary data · ${value.byteLength.toLocaleString()} bytes]`;
  if (Array.isArray(value)) return value.map((item) => item?.name || String(item)).join('; ');
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}

function csvValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `[Binary data · ${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.map((item) => item?.name || String(item)).join('; ');
  return value === null || value === undefined ? '' : String(value);
}

function setMessage(message) { $('#statusMessage').textContent = message; $('#ribbonMessage').textContent = message; }

async function init() {
  setMessage('Reading data/BMSData.accdb…');
  try {
    const response = await fetch('/data/BMSData.accdb');
    if (!response.ok) throw new Error('Could not find data/BMSData.accdb in the project folder.');
    state.reader = new MDBReader(Buffer.from(await response.arrayBuffer()));
    state.tables = state.reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false }).map((name) => {
      const table = state.reader.getTable(name);
      return { name, columns: table.getColumnNames(), definitions: table.getColumns(), count: table.rowCount };
    });
    $('#accessFileName').textContent = 'BMSData.accdb';
    $('#objectCount').textContent = state.tables.length;
    renderObjects();
    if (state.tables.length) selectTable(state.tables[0].name);
    else empty('No tables in this database', 'The reader did not find any user tables.');
    setMessage(`${state.tables.length} tables loaded from the local database.`);
  } catch (error) {
    empty('Could not read the database', error.message);
    setMessage(error.message);
  }
}

function renderObjects() {
  const host = $('#objectList'); host.replaceChildren();
  const query = $('#tableSearch').value.trim().toLowerCase();
  const filtered = state.tables.filter((table) => table.name.toLowerCase().includes(query));
  filtered.forEach((table) => {
    const button = document.createElement('button');
    button.className = `object-item${state.selected === table.name ? ' selected' : ''}`;
    button.title = `${table.name} · ${table.count.toLocaleString()} records`;
    button.innerHTML = '<span class="object-table-icon">▤</span><span class="object-name"></span>';
    button.querySelector('.object-name').textContent = table.name;
    button.addEventListener('click', () => selectTable(table.name));
    host.append(button);
  });
}

function selectTable(name) {
  state.selected = name;
  state.page = 0; state.activeRecord = 0; state.search = ''; state.sortColumn = null; state.sortDirection = 1;
  $('#findInput').value = ''; $('#recordSearch').value = '';
  const info = state.tables.find((item) => item.name === name);
  try {
    state.records = state.reader.getTable(name).getData();
    $('#currentTableTitle').textContent = name;
    $('#tableSubtitle').textContent = `${info.count.toLocaleString()} records · ${info.columns.length} fields`;
    $('#objectTabs').innerHTML = `<div class="object-tab"><span>▤</span><strong></strong><button id="closeObjectTab" title="Close table">×</button></div>`;
    $('#objectTabs .object-tab strong').textContent = name;
    $('#closeObjectTab').addEventListener('click', () => { state.selected = null; state.records = []; state.visible = []; renderObjects(); $('#objectTabs').innerHTML = '<div class="object-tab-placeholder">No table selected</div>'; $('#currentTableTitle').textContent = 'Open a table'; $('#tableSubtitle').textContent = ''; empty('Open a table to view its records', 'Choose a table in the navigation pane.'); renderRecordBar(); });
    renderObjects(); applyView();
    setMessage(`Opened ${name} in Datasheet View · read-only`);
  } catch (error) { empty('Could not read this table', error.message); }
}

function applyView() {
  const query = state.search.toLowerCase().trim();
  state.visible = state.records.filter((record) => !query || Object.values(record).some((value) => valueText(value).toLowerCase().includes(query)));
  if (state.sortColumn) {
    const field = state.sortColumn, direction = state.sortDirection;
    state.visible.sort((a, b) => {
      const av = a[field], bv = b[field];
      if (av == null) return bv == null ? 0 : -direction;
      if (bv == null) return direction;
      const an = Number(av), bn = Number(bv);
      const compared = typeof av === 'number' && typeof bv === 'number' ? an - bn : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return compared * direction;
    });
  }
  state.page = Math.min(state.page, Math.max(0, Math.ceil(state.visible.length / state.pageSize) - 1));
  renderGrid(); renderRecordBar();
}

function empty(title, hint) {
  $('#emptyTitle').textContent = title; $('#emptyHint').textContent = hint;
  $('#emptyMessage').hidden = false; grid.hidden = true;
}

function renderGrid() {
  if (!state.selected) return;
  const info = state.tables.find((item) => item.name === state.selected);
  const start = state.page * state.pageSize;
  const rows = state.visible.slice(start, start + state.pageSize);
  const head = grid.querySelector('thead'); const body = grid.querySelector('tbody');
  head.replaceChildren(); body.replaceChildren();
  const header = document.createElement('tr');
  const rowHeader = document.createElement('th'); rowHeader.textContent = '▾'; rowHeader.title = 'Record selector'; header.append(rowHeader);
  info.columns.forEach((column, index) => {
    const th = document.createElement('th');
    const def = info.definitions[index];
    th.textContent = column; th.title = `${column} · ${def?.type || 'field'} · click to sort`;
    th.addEventListener('click', () => {
      state.sortDirection = state.sortColumn === column ? -state.sortDirection : 1;
      state.sortColumn = column; applyView();
    });
    header.append(th);
  });
  head.append(header);
  rows.forEach((record, index) => {
    const tr = document.createElement('tr');
    if (start + index === state.activeRecord) tr.classList.add('current-row');
    const marker = document.createElement('td'); marker.textContent = start + index + 1; marker.title = `Record ${start + index + 1}`;
    marker.addEventListener('click', () => { state.activeRecord = start + index; renderGrid(); renderRecordBar(); }); tr.append(marker);
    info.columns.forEach((column) => {
      const td = document.createElement('td'); const value = record[column];
      td.textContent = value === null ? '(Null)' : valueText(value); td.title = td.textContent;
      if (value === null) td.style.color = '#8b8b8b';
      td.addEventListener('click', () => { state.activeRecord = start + index; document.querySelectorAll('.selected-cell').forEach((cell) => cell.classList.remove('selected-cell')); td.classList.add('selected-cell'); renderRecordBar(); });
      tr.append(td);
    });
    body.append(tr);
  });
  grid.hidden = rows.length === 0;
  $('#emptyMessage').hidden = rows.length !== 0;
  if (!rows.length) { $('#emptyTitle').textContent = state.search ? 'No matching records' : 'This table is empty'; $('#emptyHint').textContent = state.search ? 'Try a different search term.' : 'There are no records to display.'; }
}

function renderRecordBar() {
  const total = state.visible.length; const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  const start = total ? state.page * state.pageSize + 1 : 0;
  const end = Math.min((state.page + 1) * state.pageSize, total);
  $('#recordPosition').textContent = `Record ${start}–${end}`;
  $('#recordTotal').textContent = total.toLocaleString();
  $('#recordJump').value = String(state.page + 1);
  $('#firstPage').disabled = $('#previousPage').disabled = state.page === 0;
  $('#nextPage').disabled = $('#lastPage').disabled = state.page >= pageCount - 1;
  $('#filterStatus').textContent = state.search ? `Filtered · ${total.toLocaleString()} records` : 'No Filter';
}

function gotoPage(page) {
  const pageCount = Math.max(1, Math.ceil(state.visible.length / state.pageSize));
  state.page = Math.max(0, Math.min(pageCount - 1, page));
  state.activeRecord = state.page * state.pageSize;
  renderGrid(); renderRecordBar();
}

function exportTable() {
  if (!state.selected) return;
  const info = state.tables.find((item) => item.name === state.selected);
  const rows = state.reader.getTable(state.selected).getData();
  const csv = [info.columns, ...rows.map((record) => info.columns.map((column) => csvValue(record[column])))].map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
  link.download = `BMSData_${state.selected}`.replace(/[\\/:*?"<>|]+/g, '_') + '.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  setMessage(`Exported ${rows.length.toLocaleString()} records from ${state.selected}.`);
}

$('#tableSearch').addEventListener('input', renderObjects);
$('#clearTableSearch').addEventListener('click', () => { $('#tableSearch').value = ''; renderObjects(); });
$('#collapseNav').addEventListener('click', () => { $('#navigationPane').classList.toggle('collapsed'); $('#collapseNav').textContent = $('#navigationPane').classList.contains('collapsed') ? '›' : '‹'; });
$('#exportCurrent').addEventListener('click', exportTable);
$('#refreshButton').addEventListener('click', () => { if (state.selected) selectTable(state.selected); });
$('#sortAsc').addEventListener('click', () => { if (state.selected) { state.sortColumn ||= state.tables.find((t) => t.name === state.selected).columns[0]; state.sortDirection = 1; applyView(); } });
$('#sortDesc').addEventListener('click', () => { if (state.selected) { state.sortColumn ||= state.tables.find((t) => t.name === state.selected).columns[0]; state.sortDirection = -1; applyView(); } });
function updateSearch(value) { state.search = value; $('#findInput').value = value; $('#recordSearch').value = value; state.page = 0; applyView(); }
$('#findInput').addEventListener('input', (event) => updateSearch(event.target.value));
$('#recordSearch').addEventListener('input', (event) => updateSearch(event.target.value));
$('#clearFind').addEventListener('click', () => updateSearch(''));
$('#clearRecordSearch').addEventListener('click', () => updateSearch(''));
$('#firstPage').addEventListener('click', () => gotoPage(0));
$('#previousPage').addEventListener('click', () => gotoPage(state.page - 1));
$('#nextPage').addEventListener('click', () => gotoPage(state.page + 1));
$('#lastPage').addEventListener('click', () => gotoPage(Math.ceil(state.visible.length / state.pageSize) - 1));
$('#recordJump').addEventListener('change', (event) => gotoPage(Number(event.target.value) - 1 || 0));
$('#tableSearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') { const first = $('#objectList .object-item'); first?.click(); } });
document.querySelectorAll('.ribbon-tab[data-ribbon]').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.ribbon-tab[data-ribbon]').forEach((item) => item.classList.remove('active'));
  tab.classList.add('active');
  if (tab.dataset.ribbon !== 'home' && tab.dataset.ribbon !== 'table') setMessage(`${tab.textContent.trim()} commands are not available in this read-only viewer.`);
  else setMessage(state.selected ? `Opened ${state.selected} in Datasheet View · read-only` : 'Read-only preview of the tables in your database.');
}));
$('.file-tab').addEventListener('click', () => { window.location.href = 'index.html'; });
$('.ribbon-collapse').addEventListener('click', () => { document.querySelector('.ribbon').classList.toggle('ribbon-hidden'); });
init();
