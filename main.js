'use strict';

const { Adapter } = require('@iobroker/adapter-core');
const crypto = require('node:crypto');
const { Client, scaledValue } = require('./lib/client');

class ThebenSmgw extends Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'theben-smgw' });
        this.on('ready', this.ready.bind(this));
        this.on('unload', this.unload.bind(this));
        this.stopping = false;
    }
    async ready() {
        await this.setObjectNotExistsAsync('info.connection', { type: 'state', common: { name: 'Gateway verbunden', type: 'boolean', role: 'indicator.connected', read: true, write: false }, native: {} });
        await this.setStateAsync('info.connection', { val: false, ack: true });
        if (!String(this.config.host || '').trim() || !String(this.config.username || '').trim() || !this.config.password) {
            this.log.info('Bitte Gateway-Adresse und HAN-Zugang in den Instanzeinstellungen hinterlegen.');
            return;
        }
        try {
            this.client = new Client({ host: String(this.config.host || '').trim(), port: Number(this.config.port), username: String(this.config.username || '').trim(), password: this.config.password, m2mPath: this.config.m2mPath, verifyTls: this.config.verifyTls !== false, certificateFingerprint: this.config.certificateFingerprint });
        } catch (error) { this.log.error(error.message); return; }
        if (this.client.certificateFingerprint) this.log.info('Die Gateway-Identität wird anhand des konfigurierten SHA-256-Zertifikat-Fingerabdrucks geprüft.');
        else if (this.config.verifyTls === false) this.log.warn('Die TLS-Zertifikatsprüfung ist deaktiviert. Die Identität des Gateways wird nicht geprüft.');
        const minutes = Math.max(15, Math.min(1440, Number(this.config.intervalMinutes) || 15));
        this.intervalMs = minutes * 60000;
        await this.poll();
    }
    async object(id, name, type, role, unit) {
        const common = { name, type, role, read: true, write: false };
        if (unit) common.unit = unit;
        await this.extendObjectAsync(id, { type: 'state', common, native: {} });
    }
    async put(id, name, value, type = 'string', role = 'text', unit) {
        await this.object(id, name, type, role, unit);
        await this.setStateAsync(id, { val: value, ack: true });
    }
    async poll() {
        if (this.stopping) return;
        let success = true; let pointsOk = 0;
        try {
            const data = await this.client.post({ method: 'user-info' });
            const points = data?.['user-info']?.['usage-points'];
            if (!Array.isArray(points)) throw new Error('Die Antwort user-info enthält keine Usage-Point-Liste');
            const valid = points.filter(p => p && typeof p['usage-point-id'] === 'string');
            const active = valid.filter(p => !p['taf-state'] || String(p['taf-state']).toLowerCase() === 'running');
            for (const point of valid.filter(p => p['taf-state'] && String(p['taf-state']).toLowerCase() !== 'running')) {
                const statusId = `${this.profileId(point['usage-point-id'])}.status`;
                if (await this.getObjectAsync(statusId)) await this.put(statusId, 'Status', String(point['taf-state']));
            }
            if (!active.length) this.log.warn('Für diesen Zugang sind keine aktiven Nutzungsprofile sichtbar.');
            for (const point of active) {
                if (this.stopping) return;
                try { await this.readPoint(point); pointsOk++; }
                catch (error) { success = false; this.log.warn(`Ein Nutzungsprofil konnte nicht gelesen werden: ${this.safeError(error)}`); }
            }
            if (success) this.log.info(`${pointsOk} aktive Nutzungsprofile erfolgreich gelesen.`);
        } catch (error) { success = false; this.log.warn(`Gateway-Abfrage fehlgeschlagen: ${this.safeError(error)}`); }
        if (!this.stopping) {
            await this.setStateAsync('info.connection', { val: success, ack: true });
            this.timer = this.setTimeout(() => this.poll(), this.intervalMs);
        }
    }
    safeError(error) {
        if (error.code === 'CERT_HAS_EXPIRED' || error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN') return `TLS-Zertifikatsprüfung fehlgeschlagen (${error.code})`;
        if (error.code) return `Netzwerkfehler (${String(error.code).replace(/[^A-Z0-9_]/g, '')})`;
        return error.message || 'Unbekannter Fehler';
    }
    profileId(pointId) { return 'profiles.p_' + crypto.createHash('sha256').update(pointId).digest('hex').slice(0, 16); }
    async readPoint(point) {
        const pointId = point['usage-point-id'];
        const id = this.profileId(pointId);
        await this.setObjectNotExistsAsync('profiles', { type: 'channel', common: { name: 'Nutzungsprofile' }, native: {} });
        await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name: `TAF ${point['taf-number'] || '?'} - ${point['usage-point-name'] || pointId}` }, native: {} });
        await this.put(`${id}.usagePointId`, 'Usage-Point-ID', pointId);
        await this.put(`${id}.taf`, 'TAF', String(point['taf-number'] || ''));
        await this.put(`${id}.status`, 'Status', String(point['taf-state'] || 'unbekannt'));
        let channels = new Map(); let metadataFailed = false;
        try {
            const metadata = await this.client.post({ method: 'usage-point-info', 'usage-point-id': pointId, database: 'origin' });
            const databases = metadata?.['usage-point-info']?.databases;
            if (!Array.isArray(databases) || !databases.length || !Array.isArray(databases[0].channels)) throw new Error('Kanal-Metadaten fehlen');
            channels = new Map(databases[0].channels.map(c => [String(c.obis).toLowerCase(), c]));
        } catch (error) {
            metadataFailed = true;
            this.log.warn(`Kanal-Metadaten konnten nicht gelesen werden; versuche Rohwerte: ${this.safeError(error)}`);
        }
        const result = await this.client.post({ method: 'readings', 'usage-point-id': pointId, database: 'origin', 'last-reading': true });
        const readings = result?.readings?.channels;
        if (!Array.isArray(readings)) throw new Error('Messkanäle fehlen in der Gateway-Antwort');
        for (const channel of readings) {
            const obis = String(channel.obis || '').toLowerCase();
            const reading = channel.readings?.[0];
            if (!obis || !reading || reading.value === undefined) continue;
            const key = 'c_' + crypto.createHash('sha256').update(obis).digest('hex').slice(0, 16);
            const cid = `${id}.${key}`;
            const label = obis === '0100010800ff' ? 'Bezug 1.8.0' : obis === '0100020800ff' ? 'Einspeisung 2.8.0' : `OBIS ${obis}`;
            await this.setObjectNotExistsAsync(cid, { type: 'channel', common: { name: label }, native: {} });
            await this.put(`${cid}.obis`, 'OBIS-Code', obis);
            await this.put(`${cid}.meter`, 'Zählernummer', String(reading['owner-number'] || ''));
            await this.put(`${cid}.raw`, 'Rohwert', String(reading.value));
            await this.put(`${cid}.captureTime`, 'Messzeitpunkt (UTC)', String(reading['capture-time'] || ''));
            const meta = channels.get(obis);
            if (meta) {
                await this.put(`${cid}.scaler`, 'Skalierung (Zehnerpotenz)', String(meta.scaler ?? ''));
                await this.put(`${cid}.unitCode`, 'Einheitencode', String(meta.unit ?? ''));
                const unit = ({ 26: 'J', 30: 'Wh' })[Number(meta.unit)];
                const value = scaledValue(reading.value, meta.scaler);
                if (value !== null && unit) await this.put(`${cid}.value`, `${label} (skaliert)`, value, 'number', 'value', unit);
                else {
                    if (await this.getObjectAsync(`${cid}.value`)) await this.setStateAsync(`${cid}.value`, { val: null, ack: true });
                    this.log.warn(`Kanal ${obis}: Einheit oder Skalierung nicht unterstützt; nur Rohwert bereitgestellt.`);
                }
            } else {
                if (await this.getObjectAsync(`${cid}.scaler`)) await this.setStateAsync(`${cid}.scaler`, { val: '', ack: true });
                if (await this.getObjectAsync(`${cid}.unitCode`)) await this.setStateAsync(`${cid}.unitCode`, { val: '', ack: true });
                if (await this.getObjectAsync(`${cid}.value`)) await this.setStateAsync(`${cid}.value`, { val: null, ack: true });
                this.log.warn(`Kanal ${obis}: Metadaten fehlen; nur Rohwert bereitgestellt.`);
            }
        }
        if (metadataFailed) throw new Error('Kanal-Metadaten fehlen; Rohwerte wurden, soweit möglich, aktualisiert');
    }
    unload(callback) {
        this.stopping = true;
        if (this.timer) this.clearTimeout(this.timer);
        this.setState('info.connection', { val: false, ack: true }, () => callback());
    }
}
if (require.main !== module) module.exports = options => new ThebenSmgw(options);
else new ThebenSmgw();
