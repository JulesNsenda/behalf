'use strict';
// Rollback export: reads every row of behalf_records and writes a rooms.json in the file store's own on-disk shape, so the
// previous build (or this one without DATABASE_URL) can start from it. Usage, with the app stopped:
//   DATABASE_URL=... node scripts/export-rooms.js <path-to-new-rooms.json>
// It only reads (one read-only transaction, no lock, no writes to the database) and refuses to overwrite a file. It prints counts
// and error codes, never the URL or any row content. `pg` is required inside exportRooms() only.
const fs = require('fs');

const core = require('../lib/store-core');
const { pgError } = require('../lib/store-pg');
const { SCHEMA_VERSION, StoreError, KIND } = core;

const SELECT_SQL = 'SELECT kind, id, doc FROM behalf_records ORDER BY kind, id';

// The rows as the text of a store file, laid out as the file store writes it (lib/store.js writeOnce): the version, then each
// kind in KIND order, a singleton as its record and the rest as an object of id -> record; the rooms always, the others only when
// they have records. A row whose text is not JSON would break the whole file, so it is left out and counted.
function docText(rows, version) {
  const parts = [`{"schemaVersion":${version}`];
  const counts = {};
  let skipped = 0;
  for (const [kind, def] of Object.entries(KIND)) {
    const lines = [];
    for (const row of rows) {
      if (row.kind !== kind || (def.singleton && row.id !== def.singleton)) continue;
      try { JSON.parse(row.doc); } catch (e) { skipped++; continue; }
      lines.push(def.singleton ? row.doc : JSON.stringify(row.id) + ':' + row.doc);
    }
    counts[kind] = lines.length;
    if (lines.length === 0 && !def.always) continue;
    parts.push(`,"${def.key}":` + (def.singleton ? lines[0] : '{' + lines.join(',') + '}'));
  }
  parts.push('}');
  return { text: parts.join(''), counts, skipped };
}

// The meta row's version: the file store migrates rooms from it, so it goes into the file as it is.
function metaVersion(rows) {
  const row = rows.find((r) => r.kind === 'meta' && r.id === 'schema');
  let meta = null;
  try { meta = JSON.parse(row.doc); } catch (e) { /* refused below */ }
  if (!meta || typeof meta !== 'object' || !Number.isInteger(meta.version) || meta.version < 0) throw new StoreError('ESHAPE', 'the store metadata is unusable');
  if (meta.version > SCHEMA_VERSION) throw new StoreError('EFUTURESCHEMA', 'the store is from a newer version');
  return meta.version;
}

// Reads the table and writes the file. Resolves to { counts, skipped }; rejects with a StoreError whose code is safe to print.
async function exportRooms({ url, out, pgModule }) {
  if (!url) throw new StoreError('ENOURL', 'DATABASE_URL is not set');
  if (!out) throw new StoreError('ENOOUT', 'no output path given');
  if (fs.existsSync(out)) throw new StoreError('EEXIST', 'the output file already exists');
  let rows;
  try {
    const pg = pgModule || require('pg');
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 });
    client.on('error', () => {});
    await client.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '60000'");
      rows = (await client.query(SELECT_SQL)).rows;
      await client.query('ROLLBACK');
    } finally { await client.end().catch(() => {}); }
  } catch (e) { throw pgError(e); }
  if (!rows.some((r) => r.kind === 'meta' && r.id === 'schema')) throw new StoreError('ESHAPE', 'the table has no metadata row: is this the Behalf database?');
  const { text, counts, skipped } = docText(rows, metaVersion(rows));
  let fd = null;
  try {
    fd = fs.openSync(out, 'wx', 0o600);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* nothing to do */ } }
    if (!e || e.code !== 'EEXIST') { try { fs.unlinkSync(out); } catch (e2) { /* nothing was written */ } }
    throw new StoreError(core.safeCode(e, 'EIO'), 'could not write the output file');
  }
  return { counts, skipped };
}

async function main(argv, env, io = { out: process.stdout, err: process.stderr }) {
  const out = argv[0];
  if (!out || argv.length !== 1) { io.err.write('usage: DATABASE_URL=... node scripts/export-rooms.js <new rooms.json path>\n'); return 2; }
  try {
    const { counts, skipped } = await exportRooms({ url: env.DATABASE_URL, out });
    io.out.write(`exported ${counts.room} rooms, ${counts.user} users, ${counts.session} sessions, ${counts.agentkey} agent keys to ${out}\n`);
    if (skipped > 0) io.err.write(`${skipped} unusable records were left out\n`);
    return 0;
  } catch (e) {
    io.err.write(`export failed: ${core.safeCode(e, 'EPG')}\n`);
    return 1;
  }
}

if (require.main === module) main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });

module.exports = { exportRooms, docText, main };
