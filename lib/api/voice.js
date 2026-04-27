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

function mostRecentSgv (sgvs) {
  if (!sgvs || !sgvs.length) return null;
  return sgvs.reduce(function (a, b) {
    return (a && a.mills > b.mills) ? a : b;
  }, null);
}

function create (env, ctx) {
  var voice = express();

  voice.get(['/', '/*'], function getVoice (req, res) {
    var sbx = sandbox.serverInit(env, ctx);
    ctx.plugins.setProperties(sbx);

    var bgnow = sbx.properties && sbx.properties.bgnow;
    var recentMgdl = bgnow && (bgnow.mean || bgnow.last);
    var recentMills = bgnow && bgnow.mills;

    if (!recentMgdl || !recentMills) {
      var missingText = 'No recent glucose reading is available.';
      if (req.query && req.query.format === 'json') {
        res.json({ text: missingText });
      } else {
        res.type('text/plain').send(missingText);
      }
      return;
    }

    var mmolRaw = recentMgdl / 18;
    var mmol = (Math.round(mmolRaw * 10) / 10).toFixed(1);

    var sgv = mostRecentSgv(bgnow.sgvs);
    var direction = sgv ? sgv.direction : null;
    var trend = DIRECTION_TO_TREND[direction] || null;

    var relTime = formatRelativeTime(recentMills, Date.now());
    var text = buildSpeech(mmol, trend, relTime);

    if (req.query && req.query.format === 'json') {
      res.json({
        text: text
        , mgdl: Math.round(recentMgdl)
        , mmol: Number(mmol)
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
