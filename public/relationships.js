import { loadDatabase } from './harbour-data.js';

const $ = (selector) => document.querySelector(selector);
const state = { reader: null, tables: [], records: new Map(), relationships: [] };

function say(title, detail) { $('#summaryTitle').textContent = title; $('#summaryText').textContent = detail; }
function normalized(value) { return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function singular(value) {
  const word = normalized(value);
  const irregular = { people: 'person', persons: 'person', children: 'child', men: 'man', women: 'woman', teeth: 'tooth', feet: 'foot' };
  if (irregular[word]) return irregular[word];
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}
function valueKey(value) {
  if (value === null || value === undefined || value instanceof Uint8Array || Array.isArray(value)) return null;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (typeof value === 'bigint') return `number:${value.toString()}`;
  if (typeof value === 'number') return `number:${value}`;
  if (typeof value === 'boolean') return `boolean:${value ? 1 : 0}`;
  const text = String(value).trim();
  if (!text) return null;
  return `text:${text.toLocaleLowerCase()}`;
}

async function loadDatabase() {
  say('Reading relationship metadata…', 'Loading the database and checking its saved relationship definitions.');
  try {
    state.reader = await loadDatabase();
    const names = state.reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });
    state.tables = names.map((name) => {
      const table = state.reader.getTable(name);
      return { name, columns: table.getColumnNames(), rowCount: table.rowCount, definitions: table.getColumns() };
    });
    $('#relationshipSubtitle').textContent = `${state.tables.length} tables · ${state.reader.source}`;
    $('#tableInventorySubtitle').textContent = `${state.tables.length} tables in the database`;
    renderInventory();
    await analyze();
  } catch (error) {
    say('Could not read the database', error.message);
    $('#relationshipList').innerHTML = `<div class="no-relationships"><strong>Database unavailable</strong>${escapeHtml(error.message)}</div>`;
  }
}

function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }

function renderInventory() {
  const host = $('#inventoryList'); host.replaceChildren();
  state.tables.forEach((table) => {
    const item = document.createElement('div'); item.className = 'inventory-item';
    const details = document.createElement('div'), name = document.createElement('strong'), meta = document.createElement('span'), count = document.createElement('div');
    name.textContent = table.name; meta.textContent = `${table.columns.length} fields`; count.className = 'inventory-count'; count.textContent = `${table.rowCount.toLocaleString()} rows`;
    details.append(name, meta); item.append(details, count); host.append(item);
  });
}

function readDefinedRelationships() {
  const names = state.reader.getTableNames({ normalTables: true, systemTables: true, linkedTables: true });
  const candidates = names.filter((name) => /relationships/i.test(name));
  const relations = [];
  candidates.forEach((name) => {
    try {
      const rows = state.reader.getTable(name).getData();
      rows.forEach((row) => {
        const keys = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalized(key), value]));
        const get = (...wanted) => {
          for (const key of wanted) if (keys[normalized(key)] != null) return String(keys[normalized(key)]);
          return '';
        };
        const leftTable = get('szObject', 'Object', 'TableName', 'szTable');
        const leftField = get('szColumn', 'Column', 'FieldName', 'szField');
        const rightTable = get('szReferencedObject', 'ReferencedObject', 'RelatedTable', 'szRelatedObject');
        const rightField = get('szReferencedColumn', 'ReferencedColumn', 'RelatedField', 'szRelatedColumn');
        if (leftTable && leftField && rightTable && rightField && state.tables.some((table) => table.name === leftTable) && state.tables.some((table) => table.name === rightTable)) {
          relations.push({ from: leftTable, fromField: leftField, to: rightTable, toField: rightField, source: 'Access-defined', confidence: 1, cardinality: 'Defined in Access' });
        }
      });
    } catch { /* Some Access system tables are intentionally hidden or unreadable. */ }
  });
  return relations;
}

function recordsFor(table) {
  if (!state.records.has(table.name)) state.records.set(table.name, state.reader.getTable(table.name).getData());
  return state.records.get(table.name);
}

function likelyForeignKey(field, targetName) {
  const fieldName = normalized(field), target = singular(targetName);
  if (!fieldName || !target) return false;
  const stems = [
    fieldName.replace(/(foreignkey|fk|identifier|number|no|code|key|id)$/i, ''),
    fieldName.replace(/^(fk|ref)/i, '').replace(/(number|no|code|key|id)$/i, '')
  ].filter(Boolean).map(singular);
  return stems.includes(target);
}

function likelyPrimaryKey(field, tableName) {
  const key = normalized(field), table = singular(tableName);
  return ['id', 'pk', `${table}id`, `id${table}`, `${table}key`, `${table}code`, table].includes(key);
}

function measureMatch(from, fromField, to, toField) {
  const leftRows = recordsFor(from), rightRows = recordsFor(to);
  const leftValues = leftRows.map((row) => valueKey(row[fromField])).filter((value) => value !== null);
  const rightValues = rightRows.map((row) => valueKey(row[toField])).filter((value) => value !== null);
  const rightSet = new Set(rightValues);
  const leftSet = new Set(leftValues);
  if (!leftSet.size || !rightSet.size) return null;
  let matches = 0;
  leftSet.forEach((value) => { if (rightSet.has(value)) matches++; });
  const coverage = matches / leftSet.size;
  if (coverage < 0.5) return null;
  const rightUniqueness = rightSet.size / Math.max(1, rightValues.length);
  const leftUniqueness = leftSet.size / Math.max(1, leftValues.length);
  const cardinality = rightUniqueness > 0.98
    ? (leftUniqueness > 0.98 ? 'One-to-one' : 'Many-to-one')
    : 'Many-to-many · check key';
  return { confidence: coverage, matchCount: matches, cardinality };
}

function inferRelationships(defined) {
  const relations = [...defined];
  const existing = new Set(defined.map((rel) => `${rel.from}|${rel.fromField}|${rel.to}|${rel.toField}`));
  state.tables.forEach((from) => {
    from.columns.forEach((foreignField) => {
      state.tables.forEach((to) => {
        if (from.name === to.name || !likelyForeignKey(foreignField, to.name)) return;
        to.columns.filter((field) => likelyPrimaryKey(field, to.name)).forEach((primaryField) => {
          const signature = `${from.name}|${foreignField}|${to.name}|${primaryField}`;
          if (existing.has(signature)) return;
          let measured;
          try { measured = measureMatch(from, foreignField, to, primaryField); } catch { measured = null; }
          if (!measured) return;
          existing.add(signature);
          relations.push({ from: from.name, fromField: foreignField, to: to.name, toField: primaryField, source: 'Inferred from values', ...measured });
        });
      });
    });
  });
  return relations.sort((a, b) => (a.source === 'Access-defined' ? -1 : b.source === 'Access-defined' ? 1 : b.confidence - a.confidence));
}

async function analyze() {
  say('Checking saved relationships and key fields…', 'Access-defined links are checked first; possible missing links are tested against the stored values.');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const defined = readDefinedRelationships();
  state.relationships = inferRelationships(defined);
  renderRelationships();
  const definedCount = state.relationships.filter((item) => item.source === 'Access-defined').length;
  const inferredCount = state.relationships.length - definedCount;
  if (!state.relationships.length) say('No relationships found', 'No saved Access relationships or high-confidence field matches were found.');
  else say(`${state.relationships.length} possible links across ${new Set(state.relationships.flatMap((item) => [item.from, item.to])).size} tables`, `${definedCount} defined in Access · ${inferredCount} suggested from matching field names and values.`);
}

function createRelationshipCard(relation) {
  const card = document.createElement('article'); card.className = 'relationship-card';
  const left = document.createElement('div'); left.className = 'relation-side';
  const leftName = document.createElement('div'); leftName.className = 'relation-table-name'; leftName.textContent = relation.from;
  const leftField = document.createElement('span'); leftField.className = 'relation-field'; leftField.textContent = relation.fromField;
  const leftCaption = document.createElement('small'); leftCaption.className = 'relation-caption'; leftCaption.textContent = 'referencing field';
  left.append(leftName, leftField, leftCaption);
  const connector = document.createElement('div'); connector.className = 'relation-connector';
  const cardinality = document.createElement('span'); cardinality.className = 'relation-type'; cardinality.textContent = relation.cardinality || 'Linked';
  const line = document.createElement('div'); line.className = 'relation-line'; const arrow = document.createElement('span'); arrow.textContent = '›'; line.append(arrow);
  const confidence = document.createElement('span'); confidence.className = 'relation-confidence'; confidence.textContent = relation.source === 'Access-defined' ? 'saved relationship' : `${Math.round(relation.confidence * 100)}% value overlap`;
  connector.append(cardinality, line, confidence);
  const right = document.createElement('div'); right.className = 'relation-side right';
  const rightName = document.createElement('div'); rightName.className = 'relation-table-name'; rightName.textContent = relation.to;
  const rightField = document.createElement('span'); rightField.className = 'relation-field'; rightField.textContent = relation.toField;
  const rightCaption = document.createElement('small'); rightCaption.className = 'relation-caption'; rightCaption.textContent = 'referenced field';
  right.append(rightName, rightField, rightCaption);
  card.append(left, connector, right);
  const badge = document.createElement('div'); badge.className = `source-badge${relation.source === 'Access-defined' ? '' : ' inferred'}`; badge.textContent = relation.source.toUpperCase();
  left.append(badge);
  return card;
}

function renderRelationships() {
  const host = $('#relationshipList'); host.replaceChildren();
  $('#edgeCount').textContent = String(state.relationships.length).padStart(2, '0');
  if (!state.relationships.length) {
    const empty = document.createElement('div'); empty.className = 'no-relationships';
    const strong = document.createElement('strong'); strong.textContent = 'No join candidates yet';
    const detail = document.createElement('span'); detail.textContent = 'The database may use non-obvious field names, or its relationship metadata may not be readable. Review the table fields in the Access-style view.';
    empty.append(strong, detail); host.append(empty); return;
  }
  state.relationships.forEach((relation) => host.append(createRelationshipCard(relation)));
}

$('#reanalyze').addEventListener('click', () => { state.records.clear(); analyze(); });
loadDatabase();
