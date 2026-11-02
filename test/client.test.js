'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client, parseChallenge, scaledValue, normalizeFingerprint, verifyPinnedCertificate } = require('../lib/client');

test('Digest challenge mit mehreren qop-Werten und quoted comma', () => {
    assert.deepEqual(parseChallenge('Digest realm="conexa", nonce="abc", qop="auth,auth-int", algorithm=MD5'), { realm: 'conexa', nonce: 'abc', qop: 'auth,auth-int', algorithm: 'MD5' });
});

test('Skalierung nur bei belastbaren Metadaten', () => {
    assert.equal(scaledValue('123456789', -3), 123456.789);
    assert.equal(scaledValue('123456789', null), null);
    assert.equal(scaledValue('nicht numerisch', -3), null);
    assert.equal(scaledValue('9007199254740992', -3), null);
});

test('Optionaler M2M-Pfad bleibt auf dem konfigurierten Gateway', () => {
    const config = {host:'127.0.0.1', port:443, username:'user', password:'secret', verifyTls:true};
    assert.equal(new Client({...config, m2mPath:'/smgw/m2m/anderer.sm/json'}).uri, '/smgw/m2m/anderer.sm/json');
    for (const bad of ['https://anderer-host/x', '//anderer-host/x', '/smgw/m2m/../other', '/smgw/m2m/%2e%2e/other', '/smgw/m2m/a?x=1']) {
        assert.throws(() => new Client({...config, m2mPath:bad}), /M2M-Pfad/);
    }
});

test('Fingerabdruckformat und Zertifikatsgültigkeit werden geprüft', () => {
    const cert = new crypto.X509Certificate(fs.readFileSync(path.join(__dirname, 'test-cert.pem')));
    const pin = normalizeFingerprint(cert.fingerprint256);
    assert.match(pin, /^[a-f0-9]{64}$/);
    assert.throws(() => normalizeFingerprint('AA:BB'), /SHA-256/);
    assert.throws(() => normalizeFingerprint('x'.repeat(64)), /SHA-256/);
    const record = { raw: cert.raw, valid_from: cert.validFrom, valid_to: cert.validTo };
    const validTime = Date.parse(cert.validFrom) + 1000;
    assert.doesNotThrow(() => verifyPinnedCertificate(record, pin, validTime));
    assert.throws(() => verifyPinnedCertificate(record, pin, Date.parse(cert.validFrom) - 1), /gültig/);
    assert.throws(() => verifyPinnedCertificate(record, pin, Date.parse(cert.validTo) + 1), /gültig/);
    assert.throws(() => verifyPinnedCertificate({ ...record, valid_to:'ungültig' }, pin, validTime), /gültig/);
    assert.throws(() => verifyPinnedCertificate(null, pin, validTime), /prüfbares/);
});

test('Pinprüfung verhindert bei falschem Zertifikat HTTP-Anfragen und Digest-Header', async t => {
    const pem = fs.readFileSync(path.join(__dirname, 'test-cert.pem'));
    const pin = new crypto.X509Certificate(pem).fingerprint256;
    let requests = 0; let authorizationHeaders = 0;
    const server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'test-key.pem')), cert: pem }, (req, res) => {
        requests++; if (req.headers.authorization) authorizationHeaders++;
        req.resume();
        if (!req.headers.authorization) { res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="test", nonce="nonce", qop="auth"' }); res.end(); return; }
        res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"ok":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const config = {host:'127.0.0.1', port:server.address().port, username:'user', password:'secret', verifyTls:true};
    const trusted = new Client({ ...config, certificateFingerprint:pin });
    assert.deepEqual(await trusted.post({method:'user-info'}), {ok:true});
    assert.equal(requests, 2);
    const bad = new Client({ ...config, certificateFingerprint:'00'.repeat(32) });
    await assert.rejects(bad.post({method:'user-info'}), /Fingerabdruck stimmt nicht/);
    bad.challenge = {realm:'test', nonce:'nonce', qop:'auth'}; // Would send Digest on its first request if unguarded.
    await assert.rejects(bad.post({method:'readings'}), /Fingerabdruck stimmt nicht/);
    assert.equal(requests, 2, 'no HTTP request may reach the mismatched server');
    assert.equal(authorizationHeaders, 1, 'only the verified connection may receive an Authorization header');
});

test('Pinprüfung verwendet für das Gateway persistente HTTP-Verbindungen', async t => {
    const pem = fs.readFileSync(path.join(__dirname, 'test-cert.pem'));
    const pin = new crypto.X509Certificate(pem).fingerprint256;
    const connectionHeaders = [];
    const server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'test-key.pem')), cert: pem }, (req, res) => {
        connectionHeaders.push(req.headers.connection);
        req.resume();
        if (!req.headers.authorization) {
            res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="test", nonce="nonce", qop="auth"' });
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const client = new Client({ host: '127.0.0.1', port: server.address().port, username: 'user', password: 'secret', verifyTls: true, certificateFingerprint: pin });
    t.after(() => client.agent.destroy());
    assert.deepEqual(await client.post({ method: 'user-info' }), { ok: true });
    assert.deepEqual(connectionHeaders, ['keep-alive', 'keep-alive']);
});

test('HTTPS und Digest mit echtem lokalen Testserver', async t => {
    let authorized = 0;
    const md5 = s => crypto.createHash('md5').update(s).digest('hex');
    const server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'test-key.pem')), cert: fs.readFileSync(path.join(__dirname, 'test-cert.pem')) }, (req, res) => {
        const auth = req.headers.authorization;
        if (!auth) { res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="test", nonce="nonce1", qop="auth", algorithm=MD5' }); res.end(); return; }
        const values = parseChallenge(auth);
        const expected = md5(`${md5('user:test:secret')}:nonce1:${values.nc}:${values.cnonce}:auth:${md5(`POST:${req.url}`)}`);
        if (values.username !== 'user' || values.response !== expected) { res.writeHead(403); res.end(); return; }
        authorized++;
        let text = ''; req.on('data', c => text += c); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ method: JSON.parse(text).method })); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const config = {host:'127.0.0.1', port:server.address().port, username:'user', password:'secret'};
    const client = new Client({...config, verifyTls:false});
    assert.deepEqual(await client.post({method:'user-info'}), {method:'user-info'});
    assert.deepEqual(await client.post({method:'readings'}), {method:'readings'});
    assert.equal(authorized, 2);
    await assert.rejects(new Client({...config, verifyTls:true}).post({method:'user-info'}));
    await assert.rejects(new Client({...config, password:'wrong', verifyTls:false}).post({method:'user-info'}), /HTTP 403/);
});
