'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const tls = require('node:tls');
const net = require('node:net');

function normalizeFingerprint(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    if (!/^(?:[a-f\d]{64}|(?:[a-f\d]{2}:){31}[a-f\d]{2})$/i.test(input)) {
        throw new Error('Der Zertifikat-Fingerabdruck muss ein vollständiger SHA-256-Wert sein');
    }
    return input.replace(/:/g, '').toLowerCase();
}

function verifyPinnedCertificate(cert, expected, now = Date.now()) {
    if (!cert || !Buffer.isBuffer(cert.raw)) throw new Error('Das Gateway hat kein prüfbares TLS-Zertifikat geliefert');
    const notBefore = Date.parse(cert.valid_from);
    const notAfter = Date.parse(cert.valid_to);
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || now < notBefore || now > notAfter) {
        throw new Error('Das angeheftete Gateway-Zertifikat ist nicht gültig oder abgelaufen');
    }
    const actual = crypto.createHash('sha256').update(cert.raw).digest();
    if (!crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'))) throw new Error('Der Zertifikat-Fingerabdruck stimmt nicht überein');
}

class PinnedAgent extends https.Agent {
    // The CONEXA gateway expects persistent HTTP/1.1 connections.  Match the
    // Node.js HTTPS global agent's keep-alive behaviour; a reused socket has
    // already passed the certificate check in createConnection.
    constructor(fingerprint) { super({ keepAlive: true }); this.fingerprint = fingerprint; }
    createConnection(options, callback) {
        // The HTTP agent receives the socket only after validating the peer certificate;
        // no request body or Digest Authorization header can be written before that.
        const host = options.hostname || options.host;
        const socket = tls.connect({ host, port: options.port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
        let completed = false;
        const finish = (error) => {
            if (completed) return;
            completed = true;
            socket.removeListener('error', fail);
            socket.removeListener('close', closed);
            if (error) { socket.destroy(); callback(error); }
            else { socket.setTimeout(0); callback(null, socket); }
        };
        const fail = (error) => finish(error);
        const closed = () => finish(new Error('TLS-Verbindung vor der Zertifikatsprüfung geschlossen'));
        socket.once('error', fail);
        socket.once('close', closed);
        socket.setTimeout(15000, () => socket.destroy(new Error('Zeitüberschreitung bei der TLS-Verbindung')));
        socket.once('secureConnect', () => {
            try { verifyPinnedCertificate(socket.getPeerCertificate(), this.fingerprint); finish(); }
            catch (error) { finish(error); }
        });
    }
}

function parseChallenge(header) {
    if (!header || !/^Digest\s/i.test(header)) throw new Error('Gateway bietet keine unterstützte Digest-Authentifizierung an');
    const fields = {};
    const re = /([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g;
    let match;
    while ((match = re.exec(header))) fields[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
    if (!fields.realm || !fields.nonce) throw new Error('Unvollständige Digest-Anfrage des Gateways');
    return fields;
}

function digestHeader(challenge, username, password, uri, count) {
    const algorithm = (challenge.algorithm || 'MD5').toUpperCase();
    const base = algorithm.replace(/-SESS$/, '');
    if (!['MD5', 'SHA-256'].includes(base)) throw new Error('Digest-Algorithmus wird nicht unterstützt');
    if (challenge.qop && !challenge.qop.split(',').some(x => x.trim().toLowerCase() === 'auth')) throw new Error('Digest-qop auth wird nicht angeboten');
    const hash = input => crypto.createHash(base.toLowerCase().replace('-', '')).update(input, 'utf8').digest('hex');
    const cnonce = crypto.randomBytes(12).toString('hex');
    const nc = count.toString(16).padStart(8, '0');
    let ha1 = hash(`${username}:${challenge.realm}:${password}`);
    if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${challenge.nonce}:${cnonce}`);
    const ha2 = hash(`POST:${uri}`);
    const response = challenge.qop ? hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`) : hash(`${ha1}:${challenge.nonce}:${ha2}`);
    const q = value => `"${String(value).replace(/["\\]/g, '\\$&')}"`;
    const fields = [`username=${q(username)}`, `realm=${q(challenge.realm)}`, `nonce=${q(challenge.nonce)}`, `uri=${q(uri)}`, `response=${q(response)}`, `algorithm=${algorithm}`];
    if (challenge.opaque) fields.push(`opaque=${q(challenge.opaque)}`);
    if (challenge.qop) fields.push('qop=auth', `nc=${nc}`, `cnonce=${q(cnonce)}`);
    else if (algorithm.endsWith('-SESS')) fields.push(`cnonce=${q(cnonce)}`);
    return 'Digest ' + fields.join(', ');
}

class Client {
    constructor({host, port, username, password, verifyTls, m2mPath, certificateFingerprint}) {
        if (!host || /[\s/@?#]/.test(host)) throw new Error('Ungültige Gateway-IP / Hostname');
        if (!username || !password) throw new Error('HAN-Benutzername und Passwort müssen ausgefüllt sein');
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ungültiger Port');
        this.host = host; this.port = port; this.username = username; this.password = password;
        const customPath = String(m2mPath || '').trim();
        if (customPath && (!/^\/smgw\/m2m\/[a-zA-Z0-9._~%/-]+$/.test(customPath) || customPath.split('/').some(part => part === '.' || part === '..') || /%2f|%5c|%2e/i.test(customPath))) throw new Error('M2M-Pfad muss ein relativer Gateway-Pfad unter /smgw/m2m/ sein');
        this.verifyTls = verifyTls; this.uri = customPath || `/smgw/m2m/${encodeURIComponent(username)}.sm/json`;
        this.certificateFingerprint = normalizeFingerprint(certificateFingerprint);
        this.agent = this.certificateFingerprint ? new PinnedAgent(this.certificateFingerprint) : undefined;
        this.challenge = null; this.count = 0;
    }
    request(body, auth) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify(body);
            const req = https.request({ hostname: this.host, port: this.port, path: this.uri, method: 'POST', rejectUnauthorized: this.verifyTls, agent: this.agent,
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(auth ? { Authorization: auth } : {}) } }, res => {
                let data = ''; let bytes = 0;
                res.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) req.destroy(new Error('Antwort des Gateways ist zu groß')); else data += chunk; });
                res.on('end', () => resolve({status: res.statusCode, headers: res.headers, data}));
                res.on('error', reject);
            });
            req.setTimeout(15000, () => req.destroy(new Error('Zeitüberschreitung bei der Gateway-Verbindung')));
            req.on('error', reject); req.end(payload);
        });
    }
    async post(body) {
        let response = await this.request(body, this.challenge ? digestHeader(this.challenge, this.username, this.password, this.uri, ++this.count) : null);
        if (response.status === 401) {
            this.challenge = parseChallenge(response.headers['www-authenticate']); this.count = 0;
            response = await this.request(body, digestHeader(this.challenge, this.username, this.password, this.uri, ++this.count));
        }
        if (response.status === 401 || response.status === 403) throw new Error(`Anmeldung am Gateway abgelehnt (HTTP ${response.status})`);
        if (response.status !== 200) throw new Error(`Gateway meldet HTTP ${response.status}`);
        let data; try { data = JSON.parse(response.data); } catch { throw new Error('Gateway lieferte ungültiges JSON'); }
        if (data.error) throw new Error('Gateway meldet einen Fehler bei der M2M-Abfrage');
        return data;
    }
}

function scaledValue(raw, scaler) {
    if (scaler === null || scaler === undefined || scaler === '') return null;
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    if (!/^-?\d+(?:\.\d+)?$/.test(String(raw))) return null;
    const n = Number(raw); const s = Number(scaler);
    if (!Number.isFinite(n) || !Number.isInteger(s) || s < -12 || s > 12 || Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
    const value = n * 10 ** s;
    return Number.isFinite(value) ? value : null;
}

module.exports = { Client, parseChallenge, digestHeader, scaledValue, normalizeFingerprint, verifyPinnedCertificate };
