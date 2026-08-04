'use strict';

require('dotenv').config();
const { Pool, types } = require('pg');

// Keep DATE / TIME as plain strings so JSON APIs don't shift by timezone.
types.setTypeParser(types.builtins.DATE, (val) => val);
types.setTypeParser(types.builtins.TIME, (val) => String(val).slice(0, 8));
types.setTypeParser(types.builtins.TIMETZ, (val) => String(val));

/**
 * Shared pg Pool. Timestamps come back as JS Dates in UTC;
 * format for Iran (Asia/Tehran) at the application / presentation layer.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected idle client error', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withTransaction(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

module.exports = {
  pool,
  query,
  withClient,
  withTransaction,
};
