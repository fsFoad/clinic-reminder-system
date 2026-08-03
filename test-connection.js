require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

client.connect()
  .then(() => {
    console.log('Success: Connected to the database!');
    return client.end();
  })
  .catch(err => {
    console.error('Error: Failed to connect -', err.message);
  });
