const os = require('os');
const fs = require('fs');

const CGROUP_V2_PATHS = {
    memoryMax: '/sys/fs/cgroup/memory.max',
    memoryCurrent: '/sys/fs/cgroup/memory.current',
    cpuMax: '/sys/fs/cgroup/cpu.max'
};

const CGROUP_V1_PATHS = {
    memoryLimit: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    memoryUsage: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    cpuQuota: '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
    cpuPeriod: '/sys/fs/cgroup/cpu/cpu.cfs_period_us'
};

let cached = null;

function detectContainerEnvironment({ force = false } = {}) {
    if (cached !== null && !force) return cached;

    const info = { isContainerized: false, cgroupVersion: null, memoryLimit: null, cpuLimit: null };

    if (os.platform() !== 'linux') {
        cached = info;
        return info;
    }

    try {
        if (fs.existsSync(CGROUP_V2_PATHS.memoryMax)) {
            const memMax = fs.readFileSync(CGROUP_V2_PATHS.memoryMax, 'utf8').trim();
            if (memMax !== 'max') {
                const memLimit = parseInt(memMax, 10);
                if (memLimit > 0 && memLimit < os.totalmem()) {
                    info.isContainerized = true;
                    info.cgroupVersion = 2;
                    info.memoryLimit = memLimit;
                }
            }
            if (fs.existsSync(CGROUP_V2_PATHS.cpuMax)) {
                const parts = fs.readFileSync(CGROUP_V2_PATHS.cpuMax, 'utf8').trim().split(' ');
                if (parts[0] !== 'max' && parts.length === 2) {
                    const quota = parseInt(parts[0], 10);
                    const period = parseInt(parts[1], 10);
                    if (quota > 0 && period > 0) {
                        info.cpuLimit = quota / period;
                        info.isContainerized = true;
                    }
                }
            }
        } else if (fs.existsSync(CGROUP_V1_PATHS.memoryLimit)) {
            const memLimit = parseInt(fs.readFileSync(CGROUP_V1_PATHS.memoryLimit, 'utf8').trim(), 10);
            const MAX_MEMORY_LIMIT = 9223372036854771712;
            if (memLimit > 0 && memLimit < MAX_MEMORY_LIMIT && memLimit < os.totalmem()) {
                info.isContainerized = true;
                info.cgroupVersion = 1;
                info.memoryLimit = memLimit;
            }
            if (fs.existsSync(CGROUP_V1_PATHS.cpuQuota) && fs.existsSync(CGROUP_V1_PATHS.cpuPeriod)) {
                const quota = parseInt(fs.readFileSync(CGROUP_V1_PATHS.cpuQuota, 'utf8').trim(), 10);
                const period = parseInt(fs.readFileSync(CGROUP_V1_PATHS.cpuPeriod, 'utf8').trim(), 10);
                if (quota > 0 && period > 0) {
                    info.cpuLimit = quota / period;
                    info.isContainerized = true;
                }
            }
        }
    } catch (_) {
        // Treat detection errors as "not containerized". Never crash on probe.
    }

    cached = info;
    return info;
}

function readContainerMemoryUsage() {
    try {
        if (fs.existsSync(CGROUP_V2_PATHS.memoryCurrent)) {
            return parseInt(fs.readFileSync(CGROUP_V2_PATHS.memoryCurrent, 'utf8').trim(), 10);
        }
        if (fs.existsSync(CGROUP_V1_PATHS.memoryUsage)) {
            return parseInt(fs.readFileSync(CGROUP_V1_PATHS.memoryUsage, 'utf8').trim(), 10);
        }
    } catch (_) {}
    return null;
}

module.exports = { detectContainerEnvironment, readContainerMemoryUsage, CGROUP_V1_PATHS, CGROUP_V2_PATHS };
