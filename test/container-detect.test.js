const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');
const os = require('os');

describe('container-detect', function () {
    let sandbox;
    let detect;

    beforeEach(function () {
        sandbox = sinon.createSandbox();
        delete require.cache[require.resolve('../lib/container-detect.js')];
        detect = require('../lib/container-detect.js');
    });

    afterEach(function () {
        sandbox.restore();
    });

    it('returns non-containerized on non-linux', function () {
        sandbox.stub(os, 'platform').returns('darwin');
        const info = detect.detectContainerEnvironment({ force: true });
        assert.strictEqual(info.isContainerized, false);
        assert.strictEqual(info.cgroupVersion, null);
    });

    it('detects cgroup v2 memory limit below host total', function () {
        sandbox.stub(os, 'platform').returns('linux');
        sandbox.stub(os, 'totalmem').returns(16 * 1024 * 1024 * 1024);
        sandbox.stub(fs, 'existsSync').callsFake(p => p.includes('cgroup/memory.max'));
        sandbox.stub(fs, 'readFileSync').callsFake(p => {
            if (p.includes('memory.max')) return '2147483648\n';
            throw new Error('unexpected path ' + p);
        });

        const info = detect.detectContainerEnvironment({ force: true });
        assert.strictEqual(info.isContainerized, true);
        assert.strictEqual(info.cgroupVersion, 2);
        assert.strictEqual(info.memoryLimit, 2147483648);
    });

    it('ignores "max" value as no-limit in cgroup v2', function () {
        sandbox.stub(os, 'platform').returns('linux');
        sandbox.stub(fs, 'existsSync').callsFake(p => p.includes('cgroup/memory.max'));
        sandbox.stub(fs, 'readFileSync').returns('max\n');

        const info = detect.detectContainerEnvironment({ force: true });
        assert.strictEqual(info.isContainerized, false);
    });
});
