import MDBReader from 'https://esm.sh/mdb-reader@3.2.0?bundle';
import { Buffer } from 'https://esm.sh/buffer@6.0.3?bundle';

globalThis.Buffer = Buffer;

const $ = (selector) => document.querySelector(selector);
const state = { reader: null, tables: [], entityTable: null, keyField: null, people: [], selectedKey: null, tableRows: new Map(), rowIndexes: new Map(), relationFields: new Map(), edges: [], groupPages: new Map() };
const PEOPLE_WORDS = /user|person|people|member|contact|profile|account|individual|staff|worker|client|student|customer|participant|kaimahi|kaitiaki/i;

function norm(value) { return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function singular(value) { let word = norm(value).replace(/^(tbl|table)/, ''); if (word === 'people' || word === 'persons') return 'person'; if (word.endsWith('ies')) return `${word.slice(0, -3)}y`; if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1); return word; }
function token(value) {
  if (value === null || value === undefined || value instanceof Uint8Array || Array.isArray(value)) return null;
  if (value instanceof Date) return `date:${value.getTime()}`;
  const text = String(value).trim().toLocaleLowerCase();
  return text ? text : null;
}
function displayValue(value) {
  if (value === null || value === undefined) return '(Null)';
  if (value instanceof Uint8Array) return `[Binary · ${value.byteLength.toLocaleString()} bytes]`;
  if (Array.isArray(value)) return value.map((item) => item?.name || String(item)).join('; ');
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}

function personScore(table) {
  let score = PEOPLE_WORDS.test(table.name) ? 100 : 0;
  const fields = table.columns.map(norm);
  if (fields.some((field) => ['firstname', 'givenname', 'forename'].includes(field))) score += 20;
  if (fields.some((field) => ['lastname', 'surname', 'familyname'].includes(field))) score += 20;
  if (fields.some((field) => ['fullname', 'displayname', 'username'].includes(field))) score += 12;
  if (fields.some((field) => field === 'email' || field.endsWith('email'))) score += 5;
  if (fields.some((field) => field === 'id' || field.endsWith('id'))) score += 2;
  return score;
}

function getRows(table) {
  if (!state.tableRows.has(table.name)) state.tableRows.set(table.name, state.reader.getTable(table.name).getData());
  return state.tableRows.get(table.name);
}

function getIndex(table, field) {
  if (!state.rowIndexes.has(table.name)) state.rowIndexes.set(table.name, new Map());
  const tableIndexes = state.rowIndexes.get(table.name);
  if (!tableIndexes.has(field)) {
    const index = new Map();
    getRows(table).forEach((record) => {
      const key = token(record[field]); if (key === null) return;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(record);
    });
    tableIndexes.set(field, index);
  }
  return tableIndexes.get(field);
}

function addEdge(from, fromField, to, toField, source) {
  if (from === to) return;
  if (!state.tables.some((table) => table.name === from && table.columns.includes(fromField)) || !state.tables.some((table) => table.name === to && table.columns.includes(toField))) return;
  const signature = `${from}|${fromField}|${to}|${toField}`;
  if (state.edges.some((edge) => edge.signature === signature || edge.signature === `${to}|${toField}|${from}|${fromField}`)) return;
  state.edges.push({ from, fromField, to, toField, source, signature });
}

function inferTableEdges() {
  state.edges = [];
  state.relationFields.forEach((relationships, from) => relationships.forEach((relationship) => addEdge(from, relationship.field, relationship.relatedTable, relationship.relatedField, 'Access-defined')));
  state.tables.forEach((from) => from.columns.forEach((foreignField) => {
    const field = norm(foreignField);
    let stem = field.replace(/(foreignkey|identifier|number|code|key|id)$/i, '');
    if (field.startsWith('fk')) stem = field.slice(2).replace(/(number|code|key|id)$/i, '');
    if (!stem) return;
    state.tables.forEach((to) => {
      if (to.name === from.name || singular(to.name) !== singular(stem)) return;
      const toBase = singular(to.name);
      const primaryFields = to.columns.filter((column) => {
        const normalized = norm(column);
        return ['id', `${toBase}id`, `id${toBase}`, `${toBase}key`, `${toBase}code`, toBase].includes(normalized);
      });
      primaryFields.forEach((primaryField) => {
        try {
          const targetIndex = getIndex(to, primaryField);
          const sourceKeys = new Set(getRows(from).map((record) => token(record[foreignField])).filter((key) => key !== null));
          let matches = 0; sourceKeys.forEach((key) => { if (targetIndex.has(key)) matches++; });
          if (sourceKeys.size && matches / sourceKeys.size >= 0.5) addEdge(from.name, foreignField, to.name, primaryField, 'Inferred');
        } catch { /* Ignore unsupported fields while building join candidates. */ }
      });
    });
  }));
}

function populateTablePicker() {
  const select = $('#entityTable'); select.replaceChildren();
  [...state.tables].sort((a, b) => personScore(b) - personScore(a) || a.name.localeCompare(b.name)).forEach((table) => {
    const option = document.createElement('option'); option.value = table.name; option.textContent = table.name; select.append(option);
  });
  if (!state.tables.length) return;
  const chosen = [...state.tables].sort((a, b) => personScore(b) - personScore(a) || a.name.localeCompare(b.name))[0];
  select.value = chosen.name; select.disabled = false; populateKeyPicker(chosen.name);
}

function populateKeyPicker(tableName) {
  const table = state.tables.find((item) => item.name === tableName);
  const select = $('#keyField'); select.replaceChildren();
  if (!table) return;
  const base = singular(tableName);
  const sorted = [...table.columns].sort((a, b) => {
    const score = (field) => { const value = norm(field); if (value === 'id') return 100; if (value === `${base}id` || value === `id${base}`) return 95; if (value.endsWith('id')) return 55; if (value.endsWith('key')) return 40; if (value.endsWith('code')) return 30; return 0; };
    return score(b) - score(a) || table.columns.indexOf(a) - table.columns.indexOf(b);
  });
  sorted.forEach((field) => { const option = document.createElement('option'); option.value = field; option.textContent = field; select.append(option); });
  select.disabled = false; select.value = sorted[0] || ''; state.entityTable = tableName; state.keyField = select.value; loadPeople();
}

function personName(record, columns, index) {
  const find = (names) => { const col = columns.find((field) => names.includes(norm(field))); return col ? record[col] : null; };
  const first = find(['firstname', 'givenname', 'forename', 'preferredname']);
  const middle = find(['middlename', 'middleinitial']);
  const last = find(['lastname', 'surname', 'familyname']);
  const compound = [first, middle, last].filter((value) => value != null && String(value).trim()).map(String).join(' ');
  if (compound) return compound;
  for (const field of ['displayname', 'fullname', 'username', 'name', 'user', 'email', 'title']) {
    const column = columns.find((candidate) => norm(candidate) === field);
    const value = column ? record[column] : null;
    if (value != null && String(value).trim()) return String(value);
  }
  const firstText = columns.map((column) => record[column]).find((value) => typeof value === 'string' && value.trim());
  return firstText ? String(firstText) : `Person ${index + 1}`;
}

function personSubline(record, columns, key) {
  const emailColumn = columns.find((field) => /email/i.test(field));
  const email = emailColumn && record[emailColumn] != null ? String(record[emailColumn]) : '';
  return email || `${key}: ${displayValue(record[key])}`;
}

function loadPeople() {
  const table = state.tables.find((item) => item.name === state.entityTable);
  if (!table || !state.keyField) return;
  try {
    const records = getRows(table);
    state.people = records.map((record, index) => ({ record, key: record[state.keyField], name: personName(record, table.columns, index), index }))
      .filter((person) => token(person.key) !== null)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    state.selectedKey = null;
    $('#peopleSearch').value = '';
    renderPeople();
    if (state.people.length) selectPerson(state.people[0].key);
    else showEmptyDetail('No people found', `The selected key field “${state.keyField}” has no values.`);
    $('#loadStatus').textContent = '';
  } catch (error) { $('#loadStatus').textContent = `Could not read ${table.name}: ${error.message}`; }
}

function renderPeople() {
  const host = $('#peopleList'); host.replaceChildren();
  const query = $('#peopleSearch').value.trim().toLowerCase();
  const visible = state.people.filter((person) => `${person.name} ${personSubline(person.record, state.tables.find((t) => t.name === state.entityTable).columns, state.keyField)}`.toLowerCase().includes(query));
  $('#peopleTotal').textContent = `${visible.length}`;
  visible.forEach((person) => {
    const button = document.createElement('button'); button.className = `person-list-item${token(state.selectedKey) === token(person.key) ? ' selected' : ''}`;
    const avatar = document.createElement('span'); avatar.className = 'person-avatar'; avatar.textContent = person.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    const info = document.createElement('span'); info.style.minWidth = '0';
    const name = document.createElement('span'); name.className = 'person-list-name'; name.textContent = person.name;
    const sub = document.createElement('span'); sub.className = 'person-list-sub'; sub.textContent = personSubline(person.record, state.tables.find((t) => t.name === state.entityTable).columns, state.keyField);
    info.append(name, sub); button.append(avatar, info); button.addEventListener('click', () => selectPerson(person.key)); host.append(button);
  });
  if (!visible.length) { const empty = document.createElement('div'); empty.className = 'person-empty'; empty.style.minHeight = '100px'; empty.textContent = 'No matching people'; host.append(empty); }
}

function findNameColumn(columns) {
  return columns.find((field) => ['displayname', 'fullname', 'username', 'name'].includes(norm(field)))
    || columns.find((field) => ['firstname', 'givenname', 'forename'].includes(norm(field)));
}

function readRelationshipFields() {
  const map = new Map();
  try {
    const allNames = state.reader.getTableNames({ normalTables: true, systemTables: true, linkedTables: true });
    allNames.filter((name) => /relationships/i.test(name)).forEach((name) => {
      try {
        state.reader.getTable(name).getData().forEach((record) => {
          const values = Object.fromEntries(Object.entries(record).map(([key, value]) => [norm(key), value]));
          const get = (...keys) => { for (const key of keys) if (values[norm(key)] != null) return String(values[norm(key)]); return ''; };
          const leftTable = get('szObject', 'Object', 'TableName'), leftField = get('szColumn', 'Column', 'FieldName');
          const rightTable = get('szReferencedObject', 'ReferencedObject', 'RelatedTable'), rightField = get('szReferencedColumn', 'ReferencedColumn', 'RelatedField');
          if (leftTable && leftField && rightTable && rightField) {
            if (!map.has(leftTable)) map.set(leftTable, []); map.get(leftTable).push({ field: leftField, relatedTable: rightTable, relatedField: rightField });
            if (!map.has(rightTable)) map.set(rightTable, []); map.get(rightTable).push({ field: rightField, relatedTable: leftTable, relatedField: leftField });
          }
        });
      } catch { /* Hidden Access system metadata can be unavailable. */ }
    });
  } catch { /* No readable Access relationship catalog. */ }
  return map;
}

function relationshipColumnCandidates(otherTable, entityTable) {
  const entity = state.tables.find((table) => table.name === entityTable);
  const fields = new Set();
  (state.relationFields.get(entityTable) || []).filter((relationship) => relationship.relatedTable === otherTable.name && relationship.relatedField === state.keyField).forEach((relationship) => fields.add(relationship.field));
  const base = singular(entityTable);
  otherTable.columns.forEach((column) => {
    const field = norm(column);
    if (field === norm(state.keyField) && field !== 'id') fields.add(column);
    if (!field.endsWith('id')) return;
    const stem = field.slice(0, -2);
    if (stem === base || stem === `${base}s` || ['user', 'person', 'member', 'contact', 'customer', 'client', 'staff', 'employee', 'student', 'participant'].includes(stem)) fields.add(column);
  });
  return [...fields].filter((field) => otherTable.columns.includes(field));
}

function matchingRows(otherTable, personKey) {
  const key = token(personKey); if (key === null) return [];
  const fields = relationshipColumnCandidates(otherTable, state.entityTable);
  if (!fields.length) return [];
  const records = getRows(otherTable);
  const matchedRecords = new Set(), matchedFields = [];
  for (const field of fields) {
    const hits = records.filter((record) => token(record[field]) === key);
    if (hits.length) { matchedFields.push(field); hits.forEach((record) => matchedRecords.add(record)); }
  }
  return matchedFields.length ? [{ field: matchedFields.join(', '), records: [...matchedRecords] }] : [];
}

function collectRelatedRecords(person) {
  const rowsByTable = new Map([[state.entityTable, new Set([person.record])]]);
  const fieldsByTable = new Map();
  const processed = new Map();
  const addMatch = (tableName, field, rows) => {
    if (!rowsByTable.has(tableName)) rowsByTable.set(tableName, new Set());
    const matched = rowsByTable.get(tableName); let changed = false;
    if (!fieldsByTable.has(tableName)) fieldsByTable.set(tableName, new Set());
    fieldsByTable.get(tableName).add(field);
    rows.forEach((row) => { if (!matched.has(row)) { matched.add(row); changed = true; } });
    return changed;
  };
  let changed = true, passes = 0;
  while (changed && passes++ <= state.tables.length + 1) {
    changed = false;
    state.edges.forEach((edge, edgeIndex) => {
      const directions = [[edge.from, edge.fromField, edge.to, edge.toField, 'forward'], [edge.to, edge.toField, edge.from, edge.fromField, 'reverse']];
      directions.forEach(([sourceName, sourceField, targetName, targetField, direction]) => {
        const sourceRows = rowsByTable.get(sourceName); if (!sourceRows?.size) return;
        const processKey = `${edgeIndex}:${direction}`;
        if (!processed.has(processKey)) processed.set(processKey, new Set());
        const seen = processed.get(processKey), keys = new Set();
        sourceRows.forEach((row) => { const key = token(row[sourceField]); if (key !== null && !seen.has(key)) keys.add(key); });
        if (!keys.size) return;
        keys.forEach((key) => seen.add(key));
        const targetTable = state.tables.find((table) => table.name === targetName); if (!targetTable) return;
        const index = getIndex(targetTable, targetField);
        keys.forEach((key) => { const matches = index.get(key); if (matches?.length && addMatch(targetName, targetField, matches)) changed = true; });
      });
    });
  }
  return [...rowsByTable.entries()].filter(([name]) => name !== state.entityTable).map(([name, records]) => ({
    table: state.tables.find((table) => table.name === name),
    field: [...(fieldsByTable.get(name) || [])].join(', '),
    records: [...records]
  })).filter((group) => group.table && group.records.length);
}

function selectPerson(key) {
  state.selectedKey = key; state.groupPages.clear(); renderPeople();
  const person = state.people.find((item) => token(item.key) === token(key));
  if (!person) return;
  const entity = state.tables.find((table) => table.name === state.entityTable);
  const groups = collectRelatedRecords(person);
  groups.sort((a, b) => a.table.name.localeCompare(b.table.name));
  renderPersonDetail(person, entity, groups);
}

function showEmptyDetail(title, message) {
  const host = $('#personDetail'); host.replaceChildren();
  const empty = document.createElement('div'); empty.className = 'person-empty';
  const icon = document.createElement('span'); icon.textContent = '♙';
  const strong = document.createElement('strong'); strong.textContent = title;
  const small = document.createElement('small'); small.textContent = message;
  empty.append(icon, strong, small); host.append(empty);
}

function renderPersonDetail(person, entity, groups) {
  const host = $('#personDetail'); host.replaceChildren();
  const header = document.createElement('header'); header.className = 'person-header';
  const avatar = document.createElement('span'); avatar.className = 'person-large-avatar'; avatar.textContent = person.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const copy = document.createElement('div'); copy.className = 'person-heading-copy';
  const title = document.createElement('h2'); title.textContent = person.name;
  const subtitle = document.createElement('p'); subtitle.textContent = `${entity.name} · ${state.keyField}: ${displayValue(person.key)}`;
  copy.append(title, subtitle);
  const profileButton = document.createElement('button'); profileButton.className = 'profile-toggle'; profileButton.textContent = 'Profile fields ▾';
  header.append(avatar, copy, profileButton); host.append(header);
  const profile = document.createElement('div'); profile.className = 'profile-fields'; profile.hidden = true;
  entity.columns.forEach((field) => {
    const item = document.createElement('div'); item.className = 'profile-field';
    const label = document.createElement('span'); label.textContent = field;
    const value = document.createElement('strong'); value.textContent = displayValue(person.record[field]);
    item.append(label, value); profile.append(item);
  });
  profileButton.addEventListener('click', () => { profile.hidden = !profile.hidden; profileButton.textContent = profile.hidden ? 'Profile fields ▾' : 'Profile fields ▴'; });
  host.append(profile);
  const relatedHeading = document.createElement('div'); relatedHeading.className = 'related-heading';
  const text = document.createElement('div'), h3 = document.createElement('h3'), sub = document.createElement('p'), count = document.createElement('span');
  h3.textContent = 'Related records'; sub.textContent = `${groups.length} tables contain records linked by ${state.keyField}.`;
  count.className = 'related-count'; count.textContent = groups.reduce((total, group) => total + group.records.length, 0).toLocaleString();
  text.append(h3, sub); relatedHeading.append(text, count); host.append(relatedHeading);
  const groupHost = document.createElement('div'); groupHost.className = 'related-groups';
  if (!groups.length) {
    const no = document.createElement('div'); no.className = 'no-related'; no.textContent = 'No direct matching records were found in other tables. Check the selected person key or review possible links in the relationship map.'; groupHost.append(no);
  } else groups.forEach((group) => groupHost.append(makeRelatedGroup(group)));
  host.append(groupHost);
}

function makeRelatedGroup(group) {
  const details = document.createElement('details'); details.className = 'related-group'; details.open = true;
  const summary = document.createElement('summary');
  const title = document.createElement('span'); title.className = 'related-group-title'; title.textContent = group.table.name;
  const key = document.createElement('span'); key.className = 'related-group-key'; key.textContent = `${group.field} = ${displayValue(state.selectedKey)}`;
  const meta = document.createElement('span'); meta.className = 'related-group-meta'; meta.textContent = `${group.records.length.toLocaleString()} records`;
  summary.append(title, key, meta); details.append(summary);
  const wrap = document.createElement('div'); wrap.className = 'related-table-wrap';
  const table = document.createElement('table'); table.className = 'related-table';
  const columns = group.table.columns;
  const header = document.createElement('thead'), headRow = document.createElement('tr');
  columns.forEach((column) => { const th = document.createElement('th'); th.textContent = column; headRow.append(th); }); header.append(headRow); table.append(header);
  const body = document.createElement('tbody');
  const pageSize = 50;
  function drawPage(page) {
    const start = page * pageSize; body.replaceChildren();
    group.records.slice(start, start + pageSize).forEach((record) => {
      const tr = document.createElement('tr'); columns.forEach((column) => { const td = document.createElement('td'); td.textContent = displayValue(record[column]); td.title = td.textContent; tr.append(td); }); body.append(tr);
    });
    pageNote.textContent = group.records.length > pageSize ? `Showing ${start + 1}–${Math.min(start + pageSize, group.records.length)} of ${group.records.length.toLocaleString()}` : '';
    previous.disabled = page === 0; next.disabled = start + pageSize >= group.records.length;
  }
  table.append(body); wrap.append(table); details.append(wrap);
  const pager = document.createElement('div'); pager.className = 'related-pager';
  const previous = document.createElement('button'), next = document.createElement('button'), pageNote = document.createElement('span');
  previous.textContent = '← Previous'; next.textContent = 'Next →';
  previous.addEventListener('click', () => { const page = Number(pager.dataset.page || 0) - 1; pager.dataset.page = String(Math.max(0, page)); drawPage(Number(pager.dataset.page)); });
  next.addEventListener('click', () => { const page = Number(pager.dataset.page || 0) + 1; pager.dataset.page = String(page); drawPage(page); });
  pager.append(previous, pageNote, next); details.append(pager); drawPage(0);
  return details;
}

async function init() {
  $('#loadStatus').textContent = 'Reading data/BMSData.accdb…';
  try {
    const response = await fetch('/data/BMSData.accdb');
    if (!response.ok) throw new Error('Could not find data/BMSData.accdb. Keep the database in the project data folder.');
    state.reader = new MDBReader(Buffer.from(await response.arrayBuffer()));
    const names = state.reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });
    state.tables = names.map((name) => { const table = state.reader.getTable(name); return { name, columns: table.getColumnNames(), count: table.rowCount }; });
    state.relationFields = readRelationshipFields(); inferTableEdges();
    populateTablePicker();
    if (!state.tables.length) throw new Error('No tables were found in the database.');
    $('#loadStatus').textContent = `${state.tables.length} tables loaded. People tables are ranked first; choose another table if needed.`;
  } catch (error) { $('#loadStatus').textContent = error.message; showEmptyDetail('Database unavailable', error.message); }
}

$('#entityTable').addEventListener('change', (event) => populateKeyPicker(event.target.value));
$('#keyField').addEventListener('change', (event) => { state.keyField = event.target.value; loadPeople(); });
$('#peopleSearch').addEventListener('input', renderPeople);
init();
