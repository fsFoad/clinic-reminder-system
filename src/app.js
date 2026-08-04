'use strict';

const express = require('express');
const api = require('./routes/api');
const { attachUser } = require('./middleware/auth');

function createApp() {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Trace-Id'
    );
    res.setHeader('Access-Control-Expose-Headers', 'X-Trace-Id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());
  app.use(attachUser);
  app.use('/api', api);

  app.use((err, _req, res, _next) => {
    console.error(err);
    const msg = err.message || 'Internal Server Error';
    // `error` is the historical field; `message` mirrors it for Angular interceptors.
    const body = {
      error: msg,
      message: msg,
    };
    if (err.code) body.code = err.code;
    if (err.smsirStatus != null) body.smsirStatus = err.smsirStatus;
    if (err.details) body.details = err.details;
    if (err.traceId) {
      body.traceId = err.traceId;
      res.setHeader('X-Trace-Id', err.traceId);
    }
    res.status(err.status || 500).json(body);
  });

  return app;
}

module.exports = { createApp };
