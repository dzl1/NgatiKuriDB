import MDBReader from 'https://esm.sh/mdb-reader@3.2.0?bundle';
import { Buffer } from 'https://esm.sh/buffer@6.0.3?bundle';

globalThis.Buffer = Buffer;

const $ = (selector) => document.querySelector(selector);
const state = { reader: null, tables: [], entityTable: null, keyField: null, people: [], selectedKey: null, tableRows: new Map(), rowIndexes: new Map(), relationFields: new Map(), edges: [], groupPages: new Map(), listMode: 'all', nameDescending: false, applicantStatuses: new Map() };
const PEOPLE_WORDS = /user|person|people|member|contact|profile|account|individual|staff|worker|client|student|customer|participant|beneficiar|applicant|whanau|kaimahi|kaitiaki/i;

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
  if (value instanceof Date) return formatUsDate(value);
  return String(value);
}

function formatUsDate(value) {
  const month = value.getMonth() + 1;
  const day = value.getDate();
  return `${month}/${day}/${value.getFullYear()}`;
}

function applicantStatusLabel(value) {
  const key = token(value);
  if (key === null) return '';
  return state.applicantStatuses.get(key) ?? `Unmapped status (ID ${String(value)})`;
}

function displayRecordField(record, field) {
  return norm(field) === 'applicantstatusid'
    ? `${applicantStatusLabel(record[field])} (ID: ${displayValue(record[field])})`
    : displayValue(record[field]);
}

function exportFieldHeaders(prefix, field) {
  return norm(field) === 'applicantstatusid'
    ? [`${prefix} · Applicant Status`, `${prefix} · Applicant Status ID`]
    : [`${prefix} · ${field}`];
}

function exportFieldValues(record, field) {
  return norm(field) === 'applicantstatusid'
    ? [applicantStatusLabel(record[field]), record[field]]
    : [record[field]];
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

function readApplicantStatuses() {
  state.applicantStatuses.clear();
  const table = state.tables.find((item) => norm(item.name) === 'applicantstatus');
  if (!table) return;
  const idField = table.columns.find((field) => norm(field) === 'applicantstatusid');
  const labelField = table.columns.find((field) => norm(field) === 'applicantstatus');
  if (!idField || !labelField) return;
  getRows(table).forEach((record) => {
    const key = token(record[idField]);
    if (key !== null && record[labelField] !== null && record[labelField] !== undefined) {
      state.applicantStatuses.set(key, String(record[labelField]));
    }
  });
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
  select.disabled = false; select.value = sorted[0] || ''; state.entityTable = tableName; state.keyField = select.value;
  $('#listDobButton').disabled = !hasDateOfBirthField(table.columns);
  $('#listDobButton').title = $('#listDobButton').disabled ? 'This table has no recognized date-of-birth field.' : 'Sort entries by date of birth (earliest first).';
  if (state.listMode === 'dob' && $('#listDobButton').disabled) setListMode('all');
  else loadPeople();
}

function personNameParts(record, columns, index) {
  const findField = (names) => columns.find((field) => names.includes(norm(field)));
  const find = (names) => { const col = findField(names); return col ? record[col] : null; };
  const firstField = findField(['firstname', 'givenname', 'forename', 'preferredname']);
  const middleField = findField(['middlename', 'middleinitial']);
  const lastField = findField(['lastname', 'surname', 'familyname']);
  const first = firstField ? record[firstField] : null;
  const middle = middleField ? record[middleField] : null;
  const last = lastField ? record[lastField] : null;
  const compound = [first, middle, last].filter((value) => value != null && String(value).trim()).map(String).join(' ');
  if (compound) return { name: compound, first: first ?? '', last: last ?? '' };
  for (const field of ['displayname', 'fullname', 'username', 'name', 'user', 'email', 'title']) {
    const column = columns.find((candidate) => norm(candidate) === field);
    const value = column ? record[column] : null;
    if (value != null && String(value).trim()) return { name: String(value), first: '', last: String(value) };
  }
  const firstText = columns.map((column) => record[column]).find((value) => typeof value === 'string' && value.trim());
  return { name: firstText ? String(firstText) : `Person ${index + 1}`, first: '', last: firstText ? String(firstText) : `Person ${index + 1}` };
}

function personSubline(record, columns, key) {
  if (state.listMode === 'dob') {
    const dobField = columns.find((field) => ['dob', 'dateofbirth', 'birthdate'].includes(norm(field)));
    if (dobField) return `DOB: ${displayValue(record[dobField])}`;
  }
  const emailColumn = columns.find((field) => /email/i.test(field));
  const email = emailColumn && record[emailColumn] != null ? String(record[emailColumn]) : '';
  return email || `${key}: ${displayValue(record[key])}`;
}

function loadPeople() {
  const table = state.tables.find((item) => item.name === state.entityTable);
  if (!table || !state.keyField) return;
  try {
    const records = getRows(table);
    state.people = records.map((record, index) => ({ record, key: record[state.keyField], ...personNameParts(record, table.columns, index), index }))
      .filter((person) => token(person.key) !== null)
      .sort((a, b) => {
        const byLastName = a.last.localeCompare(b.last, undefined, { sensitivity: 'base', numeric: true });
        const byFirstName = a.first.localeCompare(b.first, undefined, { sensitivity: 'base', numeric: true });
        const byName = byLastName || byFirstName || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
        if (state.listMode === 'all') return state.nameDescending ? -byName : byName;
        const leftDate = dateValue(a.record, table.columns), rightDate = dateValue(b.record, table.columns);
        if (leftDate === null && rightDate !== null) return 1;
        if (rightDate === null && leftDate !== null) return -1;
        return (leftDate ?? 0) - (rightDate ?? 0) || byName;
      });
    state.selectedKey = null;
    $('#peopleSearch').value = '';
    renderPeople();
    $('#exportUsersButton').disabled = state.people.length === 0;
    if (state.people.length) selectPerson(state.people[0].key);
    else showEmptyDetail('No people found', `The selected key field “${state.keyField}” has no values.`);
    $('#loadStatus').textContent = '';
  } catch (error) { $('#loadStatus').textContent = `Could not read ${table.name}: ${error.message}`; }
}

function dateValue(record, columns) {
  const field = columns.find((column) => ['dob', 'dateofbirth', 'birthdate'].includes(norm(column)));
  const value = field ? record[field] : null;
  if (value instanceof Date) return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const usDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let year, month, day;
  if (usDate) [, month, day, year] = usDate.map(Number);
  else if (isoDate) [, year, month, day] = isoDate.map(Number);
  else return null;
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? timestamp : null;
}

function hasDateOfBirthField(columns) {
  return columns.some((column) => ['dob', 'dateofbirth', 'birthdate'].includes(norm(column)));
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

function csvCell(value) {
  let text = value === null || value === undefined ? '' : displayValue(value);
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${String(text).replaceAll('"', '""')}"`;
}

async function exportAllUsers() {
  if (!state.people.length) return;
  const button = $('#exportUsersButton');
  button.disabled = true; button.textContent = 'Preparing CSV…';
  $('#loadStatus').textContent = `Collecting linked records for ${state.people.length.toLocaleString()} users…`;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const entity = state.tables.find((table) => table.name === state.entityTable);
    const people = [...state.people].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    const relatedByPerson = [];
    const relatedTables = new Map();
    people.forEach((person) => {
      const groups = collectRelatedRecords(person).sort((a, b) => a.table.name.localeCompare(b.table.name));
      relatedByPerson.push(groups);
      groups.forEach((group) => {
        const schema = relatedTables.get(group.table.name) || { columns: group.table.columns, maxRecords: 0 };
        schema.maxRecords = Math.max(schema.maxRecords, group.records.length);
        relatedTables.set(group.table.name, schema);
      });
    });

    const orderedTables = [...relatedTables.entries()].sort(([a], [b]) => a.localeCompare(b));
    const headers = ['Person name', ...entity.columns.flatMap((column) => exportFieldHeaders(entity.name, column))];
    orderedTables.forEach(([tableName, schema]) => {
      for (let index = 0; index < schema.maxRecords; index++) schema.columns.forEach((column) => headers.push(...exportFieldHeaders(`${tableName} · ${index + 1}`, column)));
    });
    const lines = [headers.map(csvCell).join(',')];
    people.forEach((person, personIndex) => {
      const values = [person.name, ...entity.columns.flatMap((column) => exportFieldValues(person.record, column))];
      const groups = new Map(relatedByPerson[personIndex].map((group) => [group.table.name, group]));
      orderedTables.forEach(([tableName, schema]) => {
        const records = groups.get(tableName)?.records || [];
        for (let index = 0; index < schema.maxRecords; index++) {
          const record = records[index];
          schema.columns.forEach((column) => values.push(...(record ? exportFieldValues(record, column) : norm(column) === 'applicantstatusid' ? ['', ''] : [''])));
        }
      });
      lines.push(values.map(csvCell).join(','));
    });
    const blob = new Blob(['\ufeff', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'NgatiKuri_All_Users.csv';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    $('#loadStatus').textContent = `Exported ${people.length.toLocaleString()} users with their linked records to CSV.`;
  } catch (error) {
    $('#loadStatus').textContent = `Could not export users: ${error.message}`;
  } finally {
    button.disabled = false; button.textContent = 'Export all users';
  }
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

function recordCategory(group) {
  const name = norm(group.table.name), fields = group.table.columns.map(norm).join(' ');
  if (/fund|grant|application/.test(name)) return 'Funding Applications';
  if (/attach|document|file|image|photo/.test(name) || /attachment|filename|filepath|filedata/.test(fields)) return 'Attachments';
  if (/email|correspondence|communication/.test(name) || /emailbody|emailsubject|sentdate|recipient/.test(fields)) return 'Emails';
  if (/note|memo|comment|journal/.test(name) || /notetext|notecontent|memotext/.test(fields)) return 'All Notes';
  if (/contact|address|phone|telephone/.test(name) || /address|phone|telephone|constituency|hapu/.test(fields)) return 'Contact Details';
  return 'Other Records';
}

function renderPersonDetail(person, entity, groups) {
  const host = $('#personDetail'); host.replaceChildren();
  const header = document.createElement('header'); header.className = 'person-header';
  const avatar = document.createElement('span'); avatar.className = 'person-large-avatar'; avatar.textContent = person.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const copy = document.createElement('div'); copy.className = 'person-heading-copy';
  const title = document.createElement('h2'); title.textContent = person.name;
  const subtitle = document.createElement('p'); subtitle.textContent = `${entity.name} · ${state.keyField}: ${displayValue(person.key)}`;
  copy.append(title, subtitle); header.append(avatar, copy); host.append(header);

  const categories = ['Contact Details', 'Attachments', 'Emails', 'All Notes', 'Funding Applications', 'Other Records'];
  const categorized = new Map(categories.map((label) => [label, []]));
  groups.forEach((group) => categorized.get(recordCategory(group)).push(group));
  const tabs = document.createElement('div'); tabs.className = 'profile-tabs'; tabs.setAttribute('role', 'tablist');
  const panels = document.createElement('div'); panels.className = 'profile-tab-panels';
  const showTab = (name) => {
    tabs.querySelectorAll('button').forEach((button) => { const active = button.dataset.tab === name; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
    panels.querySelectorAll('.profile-tab-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
  };
  categories.forEach((name, index) => {
    const list = categorized.get(name);
    if (name === 'Other Records' && !list.length) return;
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = `profile-tab${index === 0 ? ' active' : ''}`; tab.dataset.tab = name; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(index === 0));
    tab.textContent = `${name}${list.length ? ` (${list.reduce((sum, group) => sum + group.records.length, 0)})` : ''}`;
    tab.addEventListener('click', () => showTab(name)); tabs.append(tab);
    const panel = document.createElement('section'); panel.className = 'profile-tab-panel'; panel.dataset.panel = name; panel.setAttribute('role', 'tabpanel'); panel.hidden = index !== 0;
    if (name === 'Contact Details') {
      const profile = document.createElement('div'); profile.className = 'profile-fields';
      entity.columns.forEach((field) => {
        const item = document.createElement('div'); item.className = 'profile-field';
        const label = document.createElement('span'); label.textContent = norm(field) === 'applicantstatusid' ? 'Applicant Status' : field;
        const value = document.createElement('strong'); value.textContent = displayRecordField(person.record, field);
        item.append(label, value); profile.append(item);
      });
      panel.append(profile);
    }
    const groupHost = document.createElement('div'); groupHost.className = 'related-groups';
    if (!list.length) {
      const empty = document.createElement('div'); empty.className = 'no-related'; empty.textContent = name === 'Contact Details' ? 'The main person record is shown above. No additional contact records were linked.' : `No ${name.toLowerCase()} were linked to this entry.`; groupHost.append(empty);
    } else list.forEach((group) => groupHost.append(makeRelatedGroup(group)));
    panel.append(groupHost); panels.append(panel);
  });
  host.append(tabs, panels);
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
  columns.forEach((column) => { const th = document.createElement('th'); th.textContent = norm(column) === 'applicantstatusid' ? 'Applicant Status' : column; headRow.append(th); }); header.append(headRow); table.append(header);
  const body = document.createElement('tbody');
  const pageSize = 50;
  function drawPage(page) {
    const start = page * pageSize; body.replaceChildren();
    group.records.slice(start, start + pageSize).forEach((record) => {
      const tr = document.createElement('tr'); columns.forEach((column) => { const td = document.createElement('td'); td.textContent = displayRecordField(record, column); td.title = td.textContent; tr.append(td); }); body.append(tr);
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
    readApplicantStatuses();
    state.relationFields = readRelationshipFields(); inferTableEdges();
    populateTablePicker();
    if (!state.tables.length) throw new Error('No tables were found in the database.');
    $('#loadStatus').textContent = '';
  } catch (error) { $('#loadStatus').textContent = error.message; showEmptyDetail('Database unavailable', error.message); }
}

$('#entityTable').addEventListener('change', (event) => populateKeyPicker(event.target.value));
$('#keyField').addEventListener('change', (event) => { state.keyField = event.target.value; loadPeople(); });
$('#peopleSearch').addEventListener('input', renderPeople);
$('#listAllButton').addEventListener('click', () => setListMode('all'));
$('#listDobButton').addEventListener('click', () => setListMode('dob'));
$('#sortNameButton').addEventListener('click', () => {
  if (state.listMode !== 'all') setListMode('all');
  state.nameDescending = !state.nameDescending;
  $('#sortNameButton').textContent = `Name: ${state.nameDescending ? 'Z–A' : 'A–Z'}`;
  loadPeople();
});
$('#exportUsersButton').addEventListener('click', exportAllUsers);

function setListMode(mode) {
  if (mode === 'dob') {
    const table = state.tables.find((item) => item.name === state.entityTable);
    if (!table || !hasDateOfBirthField(table.columns)) {
      $('#loadStatus').textContent = 'List by DOB is unavailable because the selected people table has no recognized date-of-birth field.';
      return;
    }
  }
  state.listMode = mode;
  $('#listAllButton').classList.toggle('active', mode === 'all');
  $('#listDobButton').classList.toggle('active', mode === 'dob');
  $('#viewBreadcrumb').textContent = mode === 'dob' ? 'List by DOB' : 'List All';
  $('#pageHeading').textContent = mode === 'dob' ? 'List by DOB' : 'List All';
  $('#peopleListLabel').textContent = mode === 'dob' ? 'Sorted by date of birth' : 'All database entries';
  $('#sortNameButton').hidden = mode === 'dob';
  if (mode === 'all') $('#sortNameButton').textContent = `Name: ${state.nameDescending ? 'Z–A' : 'A–Z'}`;
  if (state.entityTable && state.keyField) loadPeople();
}

init();
