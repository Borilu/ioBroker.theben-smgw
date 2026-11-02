'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const { tests } = require('@iobroker/testing');

// No credentials or gateway are used: the harness starts an isolated js-controller.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Unconfigured instance', getHarness => {
            it('starts without an error and asks for configuration', async function () {
                this.timeout(30000);
                const harness = getHarness();
                await harness.startAdapterAndWait();
                for (let i = 0; i < 40 && !harness.hasLog('Bitte Gateway-Adresse', 'info'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                assert.equal(harness.hasLog('Bitte Gateway-Adresse', 'info'), true);
                assert.deepEqual(harness.getLogs('error'), []);
                assert.equal(harness.isAdapterRunning(), true);
            });
        });
    },
});
