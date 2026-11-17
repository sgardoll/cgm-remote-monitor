'use strict';

/*
 * Google Home Cloud-to-cloud fulfillment for a single "CGM" device.
 *
 * Exposes the latest glucose reading (mmol/L) as a TemperatureControl
 * setpoint, since Google has no glucose trait. Single-user: account linking
 * is protected by one shared password and all tokens are stateless HMACs.
 *
 * Required environment variables (module returns 503 until all are set):
 *   SMARTHOME_CLIENT_ID      any string; paste the same value into the Google Home console
 *   SMARTHOME_CLIENT_SECRET  long random string; also signs all tokens
 *   SMARTHOME_PROJECT_ID     Google Home Developer Console project id
 *   SMARTHOME_LINK_PASSWORD  password you type once when linking in the Home app
 *
 * Endpoints (relative to where this router is mounted):
 *   GET/POST /auth         OAuth authorization endpoint
 *   POST     /token        OAuth token endpoint
 *   POST     /fulfillment  SYNC / QUERY / EXECUTE / DISCONNECT
 */

var crypto = require('crypto');
var express = require('express');
var sandbox = require('../sandbox')();

var DEVICE_ID = 'nightscout-cgm';
var AGENT_USER_ID = 'nightscout-owner';
var CODE_TTL_MS = 10 * 60 * 1000;
var ACCESS_TTL_MS = 60 * 60 * 1000;
var STALE_MS = 15 * 60 * 1000;
var MAX_ATTEMPTS = 10;
var ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function b64u (input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u (str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) { str += '='; }
  return Buffer.from(str, 'base64');
}

function digest (value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual (a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function sign (payload, key) {
  var body = b64u(JSON.stringify(payload));
  var sig = b64u(crypto.createHmac('sha256', key).update(body).digest());
  return body + '.' + sig;
}

function verify (token, key, type) {
  if (typeof token !== 'string') { return null; }
  var parts = token.split('.');
  if (parts.length !== 2) { return null; }
  var expected = b64u(crypto.createHmac('sha256', key).update(parts[0]).digest());
  if (!safeEqual(parts[1], expected)) { return null; }
  var payload;
  try {
    payload = JSON.parse(fromB64u(parts[0]).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || payload.t !== type) { return null; }
  if (payload.exp && payload.exp < Date.now()) { return null; }
  return payload;
}

function escapeHtml (value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readConfig () {
  var cfg = {
    clientId: process.env.SMARTHOME_CLIENT_ID
    , clientSecret: process.env.SMARTHOME_CLIENT_SECRET
    , projectId: process.env.SMARTHOME_PROJECT_ID
    , linkPassword: process.env.SMARTHOME_LINK_PASSWORD
  };
  cfg.enabled = !!(cfg.clientId && cfg.clientSecret && cfg.projectId && cfg.linkPassword);
  return cfg;
}

function allowedRedirects (cfg) {
  return [
    'https://oauth-redirect.googleusercontent.com/r/' + cfg.projectId
    , 'https://oauth-redirect-sandbox.googleusercontent.com/r/' + cfg.projectId
  ];
}

function bearerToken (req) {
  var match = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
  return match ? match[1] : null;
}

function loginPage (params, error) {
  var hidden = ['client_id', 'redirect_uri', 'state', 'response_type'].map(function (name) {
    return '<input type="hidden" name="' + name + '" value="' + escapeHtml(params[name]) + '">';
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Link Nightscout CGM</title></head>'
    + '<body style="font-family:sans-serif;max-width:22rem;margin:3rem auto;padding:0 1rem">'
    + '<h2>Link Nightscout CGM to Google Home</h2>'
    + (error ? '<p style="color:#b00020">' + escapeHtml(error) + '</p>' : '')
    + '<form method="post">' + hidden
    + '<p><input type="password" name="password" placeholder="Link password" autofocus required style="width:100%;padding:.6rem"></p>'
    + '<p><button type="submit" style="padding:.6rem 1.2rem">Link account</button></p>'
    + '</form></body></html>';
}

// Latest reading in mmol/L, or null when there is no fresh data.
function currentMmol (env, ctx) {
  var sbx = sandbox.serverInit(env, ctx);
  ctx.plugins.setProperties(sbx);
  var bgnow = sbx.properties && sbx.properties.bgnow;
  var mgdl = bgnow && (bgnow.mean || bgnow.last);
  if (!mgdl || !bgnow.mills) { return null; }
  if (Date.now() - bgnow.mills > STALE_MS) { return null; }
  return Math.round(mgdl / 18 * 10) / 10;
}

function syncDevice (env) {
  return {
    id: DEVICE_ID
    , type: 'action.devices.types.SENSOR'
    , traits: ['action.devices.traits.TemperatureControl']
    , name: {
      name: 'CGM'
      , defaultNames: ['Nightscout CGM']
      , nicknames: ['Glucose', 'Blood sugar']
    }
    , willReportState: false
    , attributes: {
      temperatureRange: { minThresholdCelsius: 0, maxThresholdCelsius: 40 }
      , temperatureUnitForUX: 'C'
      , queryOnlyTemperatureControl: true
    }
    , deviceInfo: {
      manufacturer: 'Nightscout'
      , model: 'CGM'
      , hwVersion: '1'
      , swVersion: String((env && env.version) || '1')
    }
  };
}

function queryDevice (env, ctx) {
  var mmol = currentMmol(env, ctx);
  if (mmol === null) {
    return { online: false, status: 'ERROR', errorCode: 'deviceOffline' };
  }
  return {
    online: true
    , status: 'SUCCESS'
    , temperatureSetpointCelsius: mmol
    , temperatureAmbientCelsius: mmol
  };
}

function create (env, ctx) {
  var cfg = readConfig();
  var router = express();

  if (!cfg.enabled) {
    router.use(function notConfigured (req, res) {
      res.status(503).type('text/plain').send('Smart home integration is not configured.');
    });
    return router;
  }

  var attempts = {};

  function tooManyAttempts (ip) {
    var now = Date.now();
    var entry = attempts[ip];
    if (!entry || now - entry.first > ATTEMPT_WINDOW_MS) {
      attempts[ip] = { first: now, count: 0 };
      return false;
    }
    return entry.count >= MAX_ATTEMPTS;
  }

  function recordFailure (ip) {
    if (attempts[ip]) { attempts[ip].count += 1; }
  }

  router.use(express.json());
  router.use(express.urlencoded({ extended: false }));

  function checkAuthParams (params) {
    if (params.response_type !== 'code') { return 'Unsupported response_type.'; }
    if (!params.client_id || !safeEqual(params.client_id, cfg.clientId)) { return 'Unknown client.'; }
    if (allowedRedirects(cfg).indexOf(params.redirect_uri) === -1) { return 'Redirect URI not allowed.'; }
    return null;
  }

  router.get('/auth', function showLogin (req, res) {
    var problem = checkAuthParams(req.query);
    if (problem) { return res.status(400).type('text/plain').send(problem); }
    res.type('html').send(loginPage(req.query));
  });

  router.post('/auth', function submitLogin (req, res) {
    var problem = checkAuthParams(req.body);
    if (problem) { return res.status(400).type('text/plain').send(problem); }

    var ip = req.ip || 'unknown';
    if (tooManyAttempts(ip)) {
      return res.status(429).type('html').send(loginPage(req.body, 'Too many attempts. Try again later.'));
    }
    if (typeof req.body.password !== 'string' || !safeEqual(req.body.password, cfg.linkPassword)) {
      recordFailure(ip);
      return res.status(401).type('html').send(loginPage(req.body, 'Incorrect password.'));
    }

    var code = sign({ t: 'code', exp: Date.now() + CODE_TTL_MS, ru: req.body.redirect_uri }, cfg.clientSecret);
    var location = req.body.redirect_uri + '?code=' + encodeURIComponent(code)
      + '&state=' + encodeURIComponent(req.body.state || '');
    res.redirect(302, location);
  });

  router.post('/token', function issueToken (req, res) {
    var body = req.body || {};
    var invalid = function (error) { return res.status(400).json({ error: error }); };

    if (!body.client_id || !body.client_secret
      || !safeEqual(body.client_id, cfg.clientId) || !safeEqual(body.client_secret, cfg.clientSecret)) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    var access = function () {
      return sign({ t: 'access', exp: Date.now() + ACCESS_TTL_MS }, cfg.clientSecret);
    };

    if (body.grant_type === 'authorization_code') {
      var code = verify(body.code, cfg.clientSecret, 'code');
      if (!code || code.ru !== body.redirect_uri) { return invalid('invalid_grant'); }
      return res.json({
        token_type: 'Bearer'
        , access_token: access()
        , refresh_token: sign({ t: 'refresh' }, cfg.clientSecret)
        , expires_in: ACCESS_TTL_MS / 1000
      });
    }

    if (body.grant_type === 'refresh_token') {
      if (!verify(body.refresh_token, cfg.clientSecret, 'refresh')) { return invalid('invalid_grant'); }
      return res.json({
        token_type: 'Bearer'
        , access_token: access()
        , expires_in: ACCESS_TTL_MS / 1000
      });
    }

    invalid('unsupported_grant_type');
  });

  router.post('/fulfillment', function fulfill (req, res) {
    if (!verify(bearerToken(req), cfg.clientSecret, 'access')) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    var body = req.body || {};
    var input = body.inputs && body.inputs[0];
    var requestId = body.requestId;

    if (!input) { return res.status(400).json({ requestId: requestId, payload: { errorCode: 'protocolError' } }); }

    switch (input.intent) {
      case 'action.devices.SYNC':
        return res.json({
          requestId: requestId
          , payload: { agentUserId: AGENT_USER_ID, devices: [syncDevice(env)] }
        });

      case 'action.devices.QUERY':
        var devices = {};
        ((input.payload && input.payload.devices) || []).forEach(function (device) {
          devices[device.id] = device.id === DEVICE_ID
            ? queryDevice(env, ctx)
            : { online: false, status: 'ERROR', errorCode: 'deviceNotFound' };
        });
        return res.json({ requestId: requestId, payload: { devices: devices } });

      case 'action.devices.EXECUTE':
        var ids = [];
        ((input.payload && input.payload.commands) || []).forEach(function (command) {
          (command.devices || []).forEach(function (device) { ids.push(device.id); });
        });
        return res.json({
          requestId: requestId
          , payload: { commands: [{ ids: ids, status: 'ERROR', errorCode: 'functionNotSupported' }] }
        });

      case 'action.devices.DISCONNECT':
        return res.json({});

      default:
        return res.status(400).json({ requestId: requestId, payload: { errorCode: 'protocolError' } });
    }
  });

  return router;
}

module.exports = create;
