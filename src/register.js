// The register, held in memory on the server so staff pages load quickly.
//
// The staff list used to download every table (about 6.7 MB) and work out each person's linked
// records in the browser. Now the server keeps one copy, works out how the tables link once, and
// serves: a light list of names (peopleList), one person with their linked records (personDetail),
// and the CSV export (exportCsv).
//
// The copy reloads in the background every few minutes, and straight away after Harbour itself
// changes the register (call invalidate()); requests after a change wait for the fresh copy.

const MAX_AGE_MS = 5 * 60 * 1000;
const DATE_TYPES = new Set(['datetime', 'datetimeextended']);
const PEOPLE_WORDS = /user|person|people|member|contact|profile|account|individual|staff|worker|client|student|customer|participant|beneficiar|applicant|whanau|kaimahi|kaitiaki/i;
const STATUS_FIELD = 'ApplicantStatusID';
/** Application phases (see public/users.js) and the ApplicantStatusID each one lists. */
export const PHASE_STATUS = { all: null, processing: 10, awaiting: 20, registered: 30, declined: 40, cancelled: 99 };

export function norm(value) { return String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function singular(value) { let word = norm(value).replace(/^(tbl|table)/, ''); if (word === 'people' || word === 'persons') return 'person'; if (word.endsWith('ies')) return `${word.slice(0, -3)}y`; if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1); return word; }
export function token(value) {
  if (value === null || value === undefined || value instanceof Uint8Array || Array.isArray(value)) return null;
  if (value instanceof Date) return `date:${value.getTime()}`;
  const text = String(value).trim().toLocaleLowerCase();
  return text ? text : null;
}

// ---- Building the in-memory register from a snapshot ----

class Register {
  constructor(snapshot) {
    this.source = snapshot.source;
    this.tables = snapshot.tables.filter((table) => !table.system).map((table) => ({
      name: table.name,
      columns: table.columns.map((column) => column.name),
      dates: table.columns.filter((column) => DATE_TYPES.has(column.type)).map((column) => column.name),
      rows: table.rows,
    }));
    this.byName = new Map(this.tables.map((table) => [table.name, table]));
    this.indexes = new Map();
    this.statuses = this.readStatuses();
    this.relationFields = readRelationshipFields(snapshot.tables.filter((table) => table.system));
    this.edges = [];
    this.inferEdges();
    this.entity = [...this.tables].sort((a, b) => personScore(b) - personScore(a) || a.name.localeCompare(b.name))[0];
    if (!this.entity) throw new Error('No tables were found in the database.');
    this.keyField = pickKeyField(this.entity);
    this.people = new Map();
    this.entity.rows.forEach((record) => { const key = token(record[this.keyField]); if (key !== null && !this.people.has(key)) this.people.set(key, record); });
  }

  index(table, field) {
    if (!this.indexes.has(table.name)) this.indexes.set(table.name, new Map());
    const tableIndexes = this.indexes.get(table.name);
    if (!tableIndexes.has(field)) {
      const index = new Map();
      table.rows.forEach((record) => {
        const key = token(record[field]); if (key === null) return;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(record);
      });
      tableIndexes.set(field, index);
    }
    return tableIndexes.get(field);
  }

  readStatuses() {
    const statuses = new Map();
    const table = this.tables.find((item) => norm(item.name) === 'applicantstatus');
    const idField = table?.columns.find((field) => norm(field) === 'applicantstatusid');
    const labelField = table?.columns.find((field) => norm(field) === 'applicantstatus');
    if (!idField || !labelField) return statuses;
    table.rows.forEach((record) => {
      const key = token(record[idField]);
      if (key !== null && record[labelField] != null) statuses.set(key, String(record[labelField]));
    });
    return statuses;
  }

  statusLabel(value) {
    const key = token(value);
    if (key === null) return '';
    return this.statuses.get(key) ?? `Unmapped status (ID ${String(value)})`;
  }

  addEdge(from, fromField, to, toField, source) {
    if (from === to) return;
    if (!this.byName.get(from)?.columns.includes(fromField) || !this.byName.get(to)?.columns.includes(toField)) return;
    const signature = `${from}|${fromField}|${to}|${toField}`;
    if (this.edges.some((edge) => edge.signature === signature || edge.signature === `${to}|${toField}|${from}|${fromField}`)) return;
    this.edges.push({ from, fromField, to, toField, source, signature });
  }

  /** Links between tables: the ones saved in Access, plus <Thing>ID columns whose values mostly match another table's key. */
  inferEdges() {
    this.relationFields.forEach((relationships, from) => relationships.forEach((relationship) => this.addEdge(from, relationship.field, relationship.relatedTable, relationship.relatedField, 'Access-defined')));
    this.tables.forEach((from) => from.columns.forEach((foreignField) => {
      const field = norm(foreignField);
      let stem = field.replace(/(foreignkey|identifier|number|code|key|id)$/i, '');
      if (field.startsWith('fk')) stem = field.slice(2).replace(/(number|code|key|id)$/i, '');
      if (!stem) return;
      this.tables.forEach((to) => {
        if (to.name === from.name || singular(to.name) !== singular(stem)) return;
        const toBase = singular(to.name);
        const primaryFields = to.columns.filter((column) => ['id', `${toBase}id`, `id${toBase}`, `${toBase}key`, `${toBase}code`, toBase].includes(norm(column)));
        primaryFields.forEach((primaryField) => {
          const targetIndex = this.index(to, primaryField);
          const sourceKeys = new Set(from.rows.map((record) => token(record[foreignField])).filter((key) => key !== null));
          let matches = 0; sourceKeys.forEach((key) => { if (targetIndex.has(key)) matches++; });
          if (sourceKeys.size && matches / sourceKeys.size >= 0.5) this.addEdge(from.name, foreignField, to.name, primaryField, 'Inferred');
        });
      });
    }));
  }

  /** Every record linked to this person, following the table links as far as they go. */
  related(record) {
    const rowsByTable = new Map([[this.entity.name, new Set([record])]]);
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
    while (changed && passes++ <= this.tables.length + 1) {
      changed = false;
      this.edges.forEach((edge, edgeIndex) => {
        const directions = [[edge.from, edge.fromField, edge.to, edge.toField, 'forward'], [edge.to, edge.toField, edge.from, edge.fromField, 'reverse']];
        directions.forEach(([sourceName, sourceField, targetName, targetField, direction]) => {
          const sourceRows = rowsByTable.get(sourceName); if (!sourceRows?.size) return;
          const processKey = `${edgeIndex}:${direction}`;
          if (!processed.has(processKey)) processed.set(processKey, new Set());
          const seen = processed.get(processKey), keys = new Set();
          sourceRows.forEach((row) => { const key = token(row[sourceField]); if (key !== null && !seen.has(key)) keys.add(key); });
          if (!keys.size) return;
          keys.forEach((key) => seen.add(key));
          const targetTable = this.byName.get(targetName); if (!targetTable) return;
          const index = this.index(targetTable, targetField);
          keys.forEach((key) => { const matches = index.get(key); if (matches?.length && addMatch(targetName, targetField, matches)) changed = true; });
        });
      });
    }
    return [...rowsByTable.entries()].filter(([name]) => name !== this.entity.name).map(([name, records]) => ({
      table: this.byName.get(name),
      field: [...(fieldsByTable.get(name) || [])].join(', '),
      records: [...records],
    })).filter((group) => group.table && group.records.length).sort((a, b) => a.table.name.localeCompare(b.table.name));
  }

  /** People in a phase ('all' for everyone), sorted by surname then first names. */
  phasePeople(view = 'all') {
    const status = PHASE_STATUS[view] ?? null;
    return [...this.people.values()]
      .filter((record) => status === null || (record[STATUS_FIELD] != null && Number(record[STATUS_FIELD]) === status))
      .map((record, index) => ({ record, ...nameParts(record, this.entity.columns, index) }))
      .sort((a, b) => compareText(a.last, b.last) || compareText(a.first, b.first) || compareText(a.name, b.name));
  }
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

function pickKeyField(table) {
  const base = singular(table.name);
  const score = (field) => { const value = norm(field); if (value === 'id') return 100; if (value === `${base}id` || value === `id${base}`) return 95; if (value.endsWith('id')) return 55; if (value.endsWith('key')) return 40; if (value.endsWith('code')) return 30; return 0; };
  return [...table.columns].sort((a, b) => score(b) - score(a) || table.columns.indexOf(a) - table.columns.indexOf(b))[0];
}

function readRelationshipFields(systemTables) {
  const map = new Map();
  systemTables.filter((table) => /relationships/i.test(table.name)).forEach((table) => table.rows.forEach((record) => {
    const values = Object.fromEntries(Object.entries(record).map(([key, value]) => [norm(key), value]));
    const get = (...keys) => { for (const key of keys) if (values[norm(key)] != null) return String(values[norm(key)]); return ''; };
    const leftTable = get('szObject', 'Object', 'TableName'), leftField = get('szColumn', 'Column', 'FieldName');
    const rightTable = get('szReferencedObject', 'ReferencedObject', 'RelatedTable'), rightField = get('szReferencedColumn', 'ReferencedColumn', 'RelatedField');
    if (leftTable && leftField && rightTable && rightField) {
      if (!map.has(leftTable)) map.set(leftTable, []); map.get(leftTable).push({ field: leftField, relatedTable: rightTable, relatedField: rightField });
      if (!map.has(rightTable)) map.set(rightTable, []); map.get(rightTable).push({ field: rightField, relatedTable: leftTable, relatedField: leftField });
    }
  }));
  return map;
}

const clean = (value) => (value != null && String(value).trim() ? String(value).trim() : '');
// Sort on the tidied name, so a stray leading space or "(" does not move someone to the top.
const sortKey = (value) => clean(value).replace(/^[^\p{L}\p{N}]+/u, '');
const compareText = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });

function nameParts(record, columns, index) {
  const findField = (names) => columns.find((field) => names.includes(norm(field)));
  const pick = (names) => { const field = findField(names); return field ? record[field] : null; };
  const first = pick(['firstname', 'givenname', 'forename', 'preferredname']);
  const middle = pick(['middlename', 'middlenames', 'middleinitial']);
  const last = pick(['lastname', 'surname', 'familyname']);
  const name = [first, middle, last].map(clean).filter(Boolean).join(' ');
  if (name) return { name, first: sortKey(first), last: sortKey(last) };
  const fallback = columns.map((column) => record[column]).find((value) => typeof value === 'string' && value.trim());
  const text = fallback ? String(fallback).trim() : `Person ${index + 1}`;
  return { name: text, first: '', last: sortKey(text) };
}

// ---- Values for JSON and CSV ----

/** Dates in the register have no time zone; SQL hands them back as UTC, so read them as UTC. */
function formatDate(value) {
  return `${value.getUTCMonth() + 1}/${value.getUTCDate()}/${value.getUTCFullYear()}`;
}

function displayValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return `[Binary · ${value.byteLength.toLocaleString()} bytes]`;
  if (Array.isArray(value)) return value.map((item) => item?.name || String(item)).join('; ');
  if (value instanceof Date) return formatDate(value);
  return String(value);
}

function csvCell(value) {
  let text = displayValue(value);
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function tableShape(table) {
  return { name: table.name, columns: table.columns, dates: table.dates };
}

// ---- The cache ----

export function createRegisterCache(loadSnapshot, { log = console } = {}) {
  let current = null;       // { register, snapshot, generation, loadedAt, listJson, snapshotJson }
  let generation = 0;       // bumps on every change Harbour makes
  const loading = new Map(); // generation -> promise

  function load() {
    const startedFor = generation;
    if (loading.has(startedFor)) return loading.get(startedFor);
    const started = Date.now();
    // A dropped connection now and then is normal in the cloud, so try a few times before giving up.
    const attempt = async (tries) => {
      try {
        return await loadSnapshot();
      } catch (error) {
        if (tries <= 1) throw error;
        log.warn?.(`[harbour] register load failed (${error.message}); trying again`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return attempt(tries - 1);
      }
    };
    const promise = attempt(3)
      .then((snapshot) => {
        const register = new Register(snapshot);
        if (!current || startedFor >= current.generation) current = { register, snapshot, generation: startedFor, loadedAt: Date.now(), listJson: null, snapshotJson: null };
        log.log?.(`[harbour] register loaded from ${register.source} in ${Date.now() - started} ms (${register.people.size} people)`);
        return current;
      })
      .finally(() => loading.delete(startedFor));
    loading.set(startedFor, promise);
    return promise;
  }

  async function get() {
    if (current && current.generation === generation) {
      if (Date.now() - current.loadedAt > MAX_AGE_MS && !loading.has(generation)) {
        load().catch((error) => log.warn?.(`[harbour] background register reload failed: ${error.message}`));
      }
      return current;
    }
    return load();
  }

  return {
    /** Starts loading now, so the first staff member does not wait. */
    warm() { load().catch((error) => log.warn?.(`[harbour] register warm-up failed: ${error.message}`)); },

    /** Call after Harbour changes the register. The next request waits for a fresh copy. */
    invalidate() { generation += 1; load().catch((error) => log.warn?.(`[harbour] register reload failed: ${error.message}`)); },

    /** The whole register as one JSON document, for the table browser pages. */
    async snapshotJson() {
      const entry = await get();
      entry.snapshotJson ??= JSON.stringify(entry.snapshot);
      return { json: entry.snapshotJson, tables: entry.snapshot.tables.length };
    },

    /** Names, emails and statuses only: what the list needs. Cached as JSON until the next reload. */
    async peopleListJson() {
      const entry = await get();
      if (!entry.listJson) {
        const { register } = entry;
        const columns = register.entity.columns;
        const field = (names) => columns.find((column) => names.includes(norm(column))) ?? null;
        const fields = {
          first: field(['firstname', 'givenname', 'forename', 'preferredname']),
          middle: field(['middlename', 'middlenames', 'middleinitial']),
          last: field(['lastname', 'surname', 'familyname']),
          email: columns.find((column) => /email/i.test(column)) ?? null,
          status: columns.includes(STATUS_FIELD) ? STATUS_FIELD : null,
        };
        const value = (record, name) => (name && record[name] != null ? record[name] : null);
        entry.listJson = JSON.stringify({
          table: register.entity.name,
          keyField: register.keyField,
          loadedAt: new Date(entry.loadedAt).toISOString(),
          statuses: [...register.statuses.entries()],
          // [key, first, middle, last, email, statusId] per person, in the register's own order.
          people: [...register.people.values()].map((record) => [
            record[register.keyField], value(record, fields.first), value(record, fields.middle), value(record, fields.last),
            value(record, fields.email), value(record, fields.status),
          ]),
        });
      }
      return entry.listJson;
    },

    /** One person's record and every record linked to them, or null if there is no such person. */
    async personDetail(key) {
      const { register } = await get();
      const record = register.people.get(token(key));
      if (!record) return null;
      return {
        table: tableShape(register.entity),
        keyField: register.keyField,
        record,
        groups: register.related(record).map((group) => ({ table: tableShape(group.table), field: group.field, records: group.records })),
      };
    },

    /** Everyone in a phase, with all their linked records, as CSV (one row per person). */
    async exportCsv(view) {
      const { register } = await get();
      const entity = register.entity;
      const people = register.phasePeople(view);
      const isStatus = (column) => norm(column) === 'applicantstatusid';
      const headersFor = (prefix, column) => (isStatus(column) ? [`${prefix} · Applicant Status`, `${prefix} · Applicant Status ID`] : [`${prefix} · ${column}`]);
      const valuesFor = (record, column) => (isStatus(column) ? [register.statusLabel(record[column]), record[column]] : [record[column]]);

      const relatedByPerson = people.map((person) => register.related(person.record));
      const relatedTables = new Map();
      relatedByPerson.forEach((groups) => groups.forEach((group) => {
        const schema = relatedTables.get(group.table.name) || { columns: group.table.columns, maxRecords: 0 };
        schema.maxRecords = Math.max(schema.maxRecords, group.records.length);
        relatedTables.set(group.table.name, schema);
      }));
      const orderedTables = [...relatedTables.entries()].sort(([a], [b]) => a.localeCompare(b));
      const headers = ['Person name', ...entity.columns.flatMap((column) => headersFor(entity.name, column))];
      orderedTables.forEach(([tableName, schema]) => {
        for (let index = 0; index < schema.maxRecords; index++) schema.columns.forEach((column) => headers.push(...headersFor(`${tableName} · ${index + 1}`, column)));
      });
      const lines = [headers.map(csvCell).join(',')];
      people.forEach((person, personIndex) => {
        const values = [person.name, ...entity.columns.flatMap((column) => valuesFor(person.record, column))];
        const groups = new Map(relatedByPerson[personIndex].map((group) => [group.table.name, group]));
        orderedTables.forEach(([tableName, schema]) => {
          const records = groups.get(tableName)?.records || [];
          for (let index = 0; index < schema.maxRecords; index++) {
            const record = records[index];
            schema.columns.forEach((column) => values.push(...(record ? valuesFor(record, column) : isStatus(column) ? ['', ''] : [''])));
          }
        });
        lines.push(values.map(csvCell).join(','));
      });
      return { csv: `﻿${lines.join('\r\n')}`, count: people.length };
    },
  };
}
