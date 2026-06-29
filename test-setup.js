// test-setup.js
// Mocha setup: silence ONLY the node:sqlite experimental warning so test output
// is pristine. All other process warnings still surface. The runtime does not
// filter this warning — it is intentionally visible in Node-RED logs.
'use strict';
const originalEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
    const message = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    const type = args[0] && typeof args[0] === 'object' ? args[0].type : args[0];
    if (type === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(message)) {
        return;
    }
    return originalEmit.call(process, warning, ...args);
};
