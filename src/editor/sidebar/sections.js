'use strict';
const { formatBytes, formatUptime, statusClass, lagStatusClass } = require('../format');

const SECTIONS = [
  // App group
  {
    id: 'app-info',
    group: 'app',
    label: 'App Info',
    icon: 'fa-info-circle',
    value: (stats) => {
      const pid = stats.nodeRed.pid || 'N/A';
      const uptime = stats.nodeRed.uptime ? formatUptime(stats.nodeRed.uptime) : 'N/A';
      return `PID ${pid} • ${uptime}`;
    },
    percent: () => null,
    sparkKey: null,
    detail: (stats) => [
      { label: 'PID', value: String(stats.nodeRed.pid || 'N/A') },
      { label: 'Uptime', value: stats.nodeRed.uptime ? formatUptime(stats.nodeRed.uptime) : 'N/A' },
    ],
  },
  {
    id: 'app-cpu',
    group: 'app',
    label: 'Node-RED CPU',
    icon: 'fa-microchip',
    value: (stats) => {
      const cpu = stats.nodeRed.cpu || 0;
      return `${cpu.toFixed(1)}%`;
    },
    percent: (stats) => stats.nodeRed.cpu || 0,
    sparkKey: 'cpu',
    detail: (stats) => [
      { label: 'CPU', value: `${(stats.nodeRed.cpu || 0).toFixed(1)}%` },
    ],
  },
  {
    id: 'app-memory',
    group: 'app',
    label: 'Node-RED Memory',
    icon: 'fa-database',
    value: (stats) => {
      const heapUsed = stats.nodeRed.memory?.heapUsed || 0;
      const heapTotal = stats.nodeRed.memory?.heapTotal || 0;
      return `${formatBytes(heapUsed)} / ${formatBytes(heapTotal)}`;
    },
    percent: (stats) => {
      const heapUsed = stats.nodeRed.memory?.heapUsed || 0;
      const heapTotal = stats.nodeRed.memory?.heapTotal || 1;
      return (heapUsed / heapTotal) * 100;
    },
    sparkKey: 'memory',
    detail: (stats) => {
      const mem = stats.nodeRed.memory || {};
      return [
        { label: 'Heap Used', value: formatBytes(mem.heapUsed || 0) },
        { label: 'Heap Total', value: formatBytes(mem.heapTotal || 0) },
        { label: 'RSS', value: formatBytes(mem.rss || 0) },
        { label: 'External', value: formatBytes(mem.external || 0) },
        { label: 'Array Buffers', value: formatBytes(mem.arrayBuffers || 0) },
      ];
    },
  },
  {
    id: 'app-lag',
    group: 'app',
    label: 'Event Loop Lag',
    icon: 'fa-hourglass-half',
    value: (stats) => {
      const lag = stats.nodeRed.eventLoopLag || 0;
      return `${lag.toFixed(2)}ms`;
    },
    percent: () => null,
    sparkKey: 'lag',
    detail: (stats) => [
      { label: 'Lag', value: `${(stats.nodeRed.eventLoopLag || 0).toFixed(2)}ms` },
    ],
  },
  // System group
  {
    id: 'sys-cpu',
    group: 'sys',
    label: 'System CPU',
    icon: 'fa-server',
    value: (stats) => {
      const cpu = stats.system.cpu?.percent || 0;
      const cores = stats.system.cpu?.cores || 1;
      return `${cpu.toFixed(1)}% (${cores} cores)`;
    },
    percent: (stats) => stats.system.cpu?.percent || 0,
    sparkKey: 'sysCpu',
    detail: (stats) => {
      const cpu = stats.system.cpu || {};
      return [
        { label: 'Usage', value: `${(cpu.percent || 0).toFixed(1)}%` },
        { label: 'Cores', value: String(cpu.cores || 'N/A') },
        { label: 'Model', value: cpu.model || 'N/A' },
      ];
    },
  },
  {
    id: 'sys-memory',
    group: 'sys',
    label: 'System Memory',
    icon: 'fa-th-large',
    value: (stats) => {
      const used = stats.system.memory?.used || 0;
      const total = stats.system.memory?.total || 0;
      return `${formatBytes(used)} / ${formatBytes(total)}`;
    },
    percent: (stats) => stats.system.memory?.usedPercent || 0,
    sparkKey: 'sysMemory',
    detail: (stats) => {
      const mem = stats.system.memory || {};
      return [
        { label: 'Used', value: formatBytes(mem.used || 0) },
        { label: 'Total', value: formatBytes(mem.total || 0) },
        { label: 'Free', value: formatBytes(mem.free || 0) },
      ];
    },
  },
  {
    id: 'sys-disk',
    group: 'sys',
    label: 'Disk Space',
    icon: 'fa-hdd-o',
    value: (stats) => {
      const used = stats.system.disk?.used || 0;
      const total = stats.system.disk?.total || 0;
      return `${formatBytes(used)} / ${formatBytes(total)}`;
    },
    percent: (stats) => stats.system.disk?.usedPercent || 0,
    sparkKey: 'sysDisk',
    detail: (stats) => {
      const disk = stats.system.disk || {};
      return [
        { label: 'Used', value: formatBytes(disk.used || 0) },
        { label: 'Total', value: formatBytes(disk.total || 0) },
        { label: 'Free', value: formatBytes(disk.free || 0) },
      ];
    },
  },
  {
    id: 'sys-info',
    group: 'sys',
    label: 'System Info',
    icon: 'fa-desktop',
    value: (stats) => {
      const model = stats.system.cpu?.model || 'Unknown';
      const cores = stats.system.cpu?.cores || 'N/A';
      return `${model} (${cores} cores)`;
    },
    percent: () => null,
    sparkKey: null,
    detail: (stats) => {
      const cpu = stats.system.cpu || {};
      const mem = stats.system.memory || {};
      return [
        { label: 'CPU Model', value: cpu.model || 'N/A' },
        { label: 'Cores', value: String(cpu.cores || 'N/A') },
        { label: 'Total Memory', value: formatBytes(mem.total || 0) },
      ];
    },
  },
];

module.exports = { SECTIONS };
