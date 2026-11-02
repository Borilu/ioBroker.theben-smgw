'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
class MockAdapter extends EventEmitter {
    constructor() { super(); this.objects = {}; this.states = {}; this.log = {info(){}, warn(){}, error(){}}; }
    async setObjectNotExistsAsync(id, obj) { this.objects[id] ||= obj; }
    async extendObjectAsync(id, obj) { this.objects[id] = obj; }
    async getObjectAsync(id) { return this.objects[id]; }
    async setStateAsync(id, state) { this.states[id] = state.val; }
    setTimeout() { return 1; }
}
const originalLoad = Module._load;
Module._load = function(request, ...args) { return request === '@iobroker/adapter-core' ? { Adapter: MockAdapter } : originalLoad.call(this, request, ...args); };
const createAdapter = require('../main');
Module._load = originalLoad;

test('Aktive Profile werden seriell verarbeitet, Archivprofile ausgelassen, Skalierung wird übernommen', async () => {
    const adapter = createAdapter();
    adapter.intervalMs = 900000;
    const calls = [];
    adapter.client = { async post(body) {
        calls.push(body);
        if (body.method === 'user-info') return { 'user-info': { 'usage-points': [
            { 'usage-point-id': 'active', 'taf-number': '7', 'taf-state': 'running' },
            { 'usage-point-id': 'archived', 'taf-number': '1', 'taf-state': 'archive' },
            { 'usage-point-id': 'stopped', 'taf-number': '7', 'taf-state': 'stopped' }
        ] } };
        if (body.method === 'usage-point-info') return { 'usage-point-info': { databases: [{ channels: [{ obis:'0100010800ff', scaler:-3, unit:30 }] }] } };
        return { readings: { channels: [{ obis:'0100010800ff', readings:[{ value:'123456789', 'owner-number':'meter.sm', 'capture-time':'2024-01-01T00:00:00Z' }] }] } };
    }};
    await adapter.poll();
    assert.deepEqual(calls.map(c => c.method), ['user-info', 'usage-point-info', 'readings']);
    assert.equal(calls[2]['last-reading'], true);
    assert.equal(adapter.states['info.connection'], true);
    const valueId = Object.keys(adapter.states).find(k => k.endsWith('.value'));
    assert.equal(adapter.states[valueId], 123456.789);
    assert.equal(adapter.objects[valueId].common.unit, 'Wh');
    assert.ok(Object.values(adapter.states).includes('meter.sm'));
});

test('Bei fehlgeschlagenen Metadaten bleiben Rohwerte abrufbar; alte skalierte Werte werden ungültig', async () => {
    const adapter = createAdapter();
    adapter.intervalMs = 900000;
    let metadataWorks = true;
    adapter.client = { async post(body) {
        if (body.method === 'user-info') return { 'user-info': { 'usage-points': [{ 'usage-point-id': 'active', 'taf-number':'7', 'taf-state':'running' }] } };
        if (body.method === 'usage-point-info') {
            if (!metadataWorks) throw new Error('Nicht verfügbar');
            return { 'usage-point-info': { databases: [{ channels: [{ obis:'0100010800ff', scaler:-3, unit:30 }] }] } };
        }
        return { readings: { channels: [{ obis:'0100010800ff', readings:[{ value:'123456789' }] }] } };
    }};
    await adapter.poll();
    const valueId = Object.keys(adapter.states).find(k => k.endsWith('.value'));
    assert.equal(adapter.states[valueId], 123456.789);
    metadataWorks = false;
    await adapter.poll();
    assert.equal(adapter.states[valueId], null);
    assert.equal(adapter.states[valueId.replace(/\.value$/, '.raw')], '123456789');
    assert.equal(adapter.states[valueId.replace(/\.value$/, '.scaler')], '');
    assert.equal(adapter.states[valueId.replace(/\.value$/, '.unitCode')], '');
    assert.equal(adapter.states['info.connection'], false);
});

test('Zuvor aktives Profil wird als gestoppt markiert', async () => {
    const adapter = createAdapter(); adapter.intervalMs = 900000;
    const statusId = adapter.profileId('active') + '.status';
    adapter.objects[statusId] = { type: 'state' }; adapter.states[statusId] = 'running';
    adapter.client = { async post() { return { 'user-info': { 'usage-points': [{ 'usage-point-id': 'active', 'taf-state': 'stopped' }] } }; } };
    await adapter.poll();
    assert.equal(adapter.states[statusId], 'stopped');
});

test('Passwort ist zum Verschlüsseln und Schützen auf oberster Ebene markiert', () => {
    const config = require('../io-package.json');
    assert.ok(config.encryptedNative.includes('password'));
    assert.ok(config.protectedNative.includes('password'));
});
