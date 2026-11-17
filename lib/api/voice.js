'use strict';

var express = require('express');
var sandbox = require('../sandbox')();

var DIRECTION_TO_TREND = {
  DoubleUp: 'rising rapidly'
  , SingleUp: 'rising'
  , FortyFiveUp: 'rising slowly'
  , Flat: 'steady'
  , FortyFiveDown: 'falling slowly'
  , SingleDown: 'falling'
  , DoubleDown: 'falling rapidly'
};

function formatRelativeTime (mills, now) {
  var seconds = Math.max(0, Math.round((now - mills) / 1000));
  if (seconds < 60) return 'just now';
  var minutes = Math.round(seconds / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return minutes + ' minutes ago';
  var hours = Math.round(minutes / 60);
  if (hours === 1) return 'an hour ago';
  if (hours < 24) return hours + ' hours ago';
  return 'over a day ago';
}

function buildSpeech (mmol, trend, relTime) {
  var speech = 'Your glucose is ' + mmol;
  if (trend) speech += ', ' + trend;
  speech += ', as of ' + relTime + '.';
  return speech;
}

function mostRecentSgv (sgvs, now) {
  if (!sgvs || !sgvs.length) return null;
  return sgvs.reduce(function (a, b) {
    if (!b || !Number.isFinite(Number(b.mills)) || Number(b.mills) <= 0 || Number(b.mills) > now) return a;
    return (a && Number(a.mills) > Number(b.mills)) ? a : b;
  }, null);
}

function create (env, ctx) {
  var voice = express();

  voice.get(['/', '/*'], ctx.authorization.isPermitted('api:entries:read'), function getVoice (req, res) {
    var sbx = sandbox.serverInit(env, ctx);
    // Read the latest entry directly: display plugins may be disabled, and
    // averaging would discard LOW or turn HIGH into a misleading exact value.
    var sgv = mostRecentSgv(sbx.data.sgvs, sbx.time);
    var recentMgdl = sgv && Number(sgv.mgdl);
    var recentMills = sgv && Number(sgv.mills);

    if (!Number.isFinite(recentMgdl) || recentMgdl < 39 || !recentMills) {
      var missingText = 'No recent glucose reading is available.';
      if (req.query && req.query.format === 'json') {
        res.json({ text: missingText });
      } else {
        res.type('text/plain').send(missingText);
      }
      return;
    }

    // Nightscout displayBg defines these as out-of-range sentinels. Never
    // expose them as exact glucose measurements in speech or JSON.
    var status = recentMgdl === 39 ? 'low' : recentMgdl === 401 ? 'high' : 'ok';
    var mmolRaw = recentMgdl / 18;
    var mmol = (Math.round(mmolRaw * 10) / 10).toFixed(1);

    var direction = sgv ? sgv.direction : null;
    var trend = DIRECTION_TO_TREND[direction] || null;

    var relTime = formatRelativeTime(recentMills, Date.now());
    // Unitless numeric speech is intentional for this voice client.
    var text = buildSpeech(status === 'ok' ? mmol : status, trend, relTime);

    if (req.query && req.query.format === 'json') {
      res.json({
        text: text
        , status: status
        , mgdl: status === 'ok' ? Math.round(recentMgdl) : null
        , mmol: status === 'ok' ? Number(mmol) : null
        , direction: direction
        , trend: trend
        , mills: recentMills
      });
      return;
    }

    res.type('text/plain').send(text);
  });

  return voice;
}

module.exports = create;
