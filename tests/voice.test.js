'use strict';

var assert = require('assert');
var request = require('supertest');
var createVoice = require('../lib/api/voice');

describe('Voice endpoint', function () {
  var ctx, env, now;

  beforeEach(function () {
    now = Date.now();
    env = {settings: {units: 'mmol'}};
    ctx = {
      ddata: require('../lib/data/ddata')()
      , language: require('../lib/language')()
      , authorization: {isPermitted: function (permission) {
        assert.strictEqual(permission, 'api:entries:read');
        return function (req, res, next) { next(); };
      }}
      // No enabled bgnow plugin: the endpoint must not depend on it.
      , plugins: {setProperties: function () { throw new Error('Display plugin dependency'); }}
    };
  });

  function entry(value, age, direction) {
    return {mgdl: value, mills: now - (age || 0), direction: direction || 'Flat'};
  }

  [39, '39', 401, '401'].forEach(function (value) {
    var status = Number(value) === 39 ? 'low' : 'high';
    it('speaks ' + status + ' for sentinel ' + JSON.stringify(value), function () {
      ctx.ddata.sgvs = [entry(value)];
      return request(createVoice(env, ctx)).get('/').expect(200)
        .expect('Content-Type', /text\/plain/)
        .expect('Your glucose is ' + status + ', steady, as of just now.');
    });
    it('does not return exact numeric measurements for ' + JSON.stringify(value), function () {
      ctx.ddata.sgvs = [entry(100, 60000), entry(value)];
      return request(createVoice(env, ctx)).get('/?format=json').expect(200).then(function (res) {
        assert.strictEqual(res.body.status, status);
        assert.strictEqual(res.body.mgdl, null);
        assert.strictEqual(res.body.mmol, null);
        assert.strictEqual(res.body.mills, now);
      });
    });
  });

  it('uses the latest entry, not a bucket average, without display plugins', function () {
    ctx.ddata.sgvs = [entry(108, 240000, 'SingleUp'), entry(39, 300000)];
    return request(createVoice(env, ctx)).get('/?format=json').expect(200).then(function (res) {
      assert.strictEqual(res.body.text, 'Your glucose is 6.0, rising, as of 4 minutes ago.');
      assert.strictEqual(res.body.mgdl, 108);
      assert.strictEqual(res.body.mmol, 6);
      assert.strictEqual(res.body.status, 'ok');
      assert.strictEqual(res.body.mills, now - 240000);
    });
  });

  it('ignores future and malformed timestamps', function () {
    ctx.ddata.sgvs = [entry(108), entry(401, -60000), {mgdl: 39, mills: 'bad'}, null];
    return request(createVoice(env, ctx)).get('/').expect(200)
      .expect('Your glucose is 6.0, steady, as of just now.');
  });

  [null, 0, 38, 'bad', Infinity].forEach(function (value) {
    it('does not substitute an older reading for invalid latest value ' + value, function () {
      ctx.ddata.sgvs = [entry(108, 300000), entry(value)];
      return request(createVoice(env, ctx)).get('/').expect(200)
        .expect('No recent glucose reading is available.');
    });
  });

  it('handles empty data in JSON', function () {
    return request(createVoice(env, ctx)).get('/?format=json').expect(200)
      .expect({text: 'No recent glucose reading is available.'});
  });

  it('omits unknown trends and keeps old readings explicitly dated', function () {
    ctx.ddata.sgvs = [entry(108, 2 * 86400000, 'NOT COMPUTABLE')];
    return request(createVoice(env, ctx)).get('/').expect(200)
      .expect('Your glucose is 6.0, as of over a day ago.');
  });

  it('retains authorization middleware', function () {
    ctx.authorization.isPermitted = function (permission) {
      assert.strictEqual(permission, 'api:entries:read');
      return function (req, res) { res.sendStatus(403); };
    };
    ctx.ddata.sgvs = [entry(108)];
    return request(createVoice(env, ctx)).get('/?format=json').expect(403);
  });
});
