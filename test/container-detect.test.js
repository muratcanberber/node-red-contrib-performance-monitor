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
        assert.strictEqual(info.memoryLimit, null);
        assert.strictEqual(info.cpuLimit, null);
    });

    it('detects cgroup v2 memory and cpu limits', function () {
        sandbox.stub(os, 'platform').returns('linux');
        sandbox.stub(os, 'totalmem').returns(16 * 1024 * 1024 * 1024);
        sandbox.stub(fs, 'existsSync').callsFake(function (inputPath) {
            return inputPath === detect.CGROUP_V2_PATHS.memoryMax ||
                inputPath === detect.CGROUP_V2_PATHS.cpuMax;
        });
        sandbox.stub(fs, 'readFileSync').callsFake(function (inputPath) {
            if (inputPath === detect.CGROUP_V2_PATHS.memoryMax) {
                return '2147483648\n';
            }
            if (inputPath === detect.CGROUP_V2_PATHS.cpuMax) {
                return '200000 100000\n';
            }
            throw new Error('unexpected path ' + inputPath);
        });

        const info = detect.detectContainerEnvironment({ force: true });

        assert.strictEqual(info.isContainerized, true);
        assert.strictEqual(info.cgroupVersion, 2);
        assert.strictEqual(info.memoryLimit, 2147483648);
        assert.strictEqual(info.cpuLimit, 2);
    });

    it('detects cgroup v1 memory and cpu limits', function () {
        sandbox.stub(os, 'platform').returns('linux');
        sandbox.stub(os, 'totalmem').returns(16 * 1024 * 1024 * 1024);
        sandbox.stub(fs, 'existsSync').callsFake(function (inputPath) {
            return inputPath === detect.CGROUP_V1_PATHS.memoryLimit ||
                inputPath === detect.CGROUP_V1_PATHS.cpuQuota ||
                inputPath === detect.CGROUP_V1_PATHS.cpuPeriod;
        });
        sandbox.stub(fs, 'readFileSync').callsFake(function (inputPath) {
            if (inputPath === detect.CGROUP_V1_PATHS.memoryLimit) {
                return '1073741824\n';
            }
            if (inputPath === detect.CGROUP_V1_PATHS.cpuQuota) {
                return '50000\n';
            }
            if (inputPath === detect.CGROUP_V1_PATHS.cpuPeriod) {
                return '100000\n';
            }
            throw new Error('unexpected path ' + inputPath);
        });

        const info = detect.detectContainerEnvironment({ force: true });

        assert.strictEqual(info.isContainerized, true);
        assert.strictEqual(info.cgroupVersion, 1);
        assert.strictEqual(info.memoryLimit, 1073741824);
        assert.strictEqual(info.cpuLimit, 0.5);
    });

    it('reads cgroup memory usage from v2 and v1 paths', function () {
        sandbox.stub(os, 'platform').returns('linux');
        sandbox.stub(os, 'totalmem').returns(16 * 1024 * 1024 * 1024);
        sandbox.stub(fs, 'existsSync').callsFake(function (inputPath) {
            return inputPath === detect.CGROUP_V2_PATHS.memoryMax ||
                inputPath === detect.CGROUP_V2_PATHS.memoryCurrent;
        });
        sandbox.stub(fs, 'readFileSync').callsFake(function (inputPath) {
            if (inputPath === detect.CGROUP_V2_PATHS.memoryMax) {
                return '2147483648\n';
            }
            if (inputPath === detect.CGROUP_V2_PATHS.memoryCurrent) {
                return '123456789\n';
            }
            throw new Error('unexpected path ' + inputPath);
        });

        detect.detectContainerEnvironment({ force: true });

        assert.strictEqual(detect.readContainerMemoryUsage(), 123456789);
    });
});
