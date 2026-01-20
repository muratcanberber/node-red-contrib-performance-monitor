# Node-RED Performance Monitor (Developer HUD)

A high-fidelity performance monitoring extension for Node-RED that provides a **"Tech HUD"** sidebar and a **Persistent Header Stats Bar**. Designed for developers who need real-time, glanceable insights into their Node-RED instance's resource usage.

![V4 Developer HUD](/home/mcb/.gemini/antigravity/brain/dd30c223-8445-4799-8bfb-a9ab984463a1/v4_developer_hud_final_1768911148172.png)
*(Note: Floating stats bar visible in the top header)*

## Features

### 1. Persistent Developer HUD (Top Bar)
A transparent, always-visible widget injected into the Node-RED editor header.
*   **CPU Load**: Real-time system CPU percentage.
*   **Stacked RAM Bar**: "Ingenious" visualization showing:
    *   **Bright**: Node-RED Heap Used (e.g., 64MB)
    *   **Dim**: Other System Memory
    *   **Empty**: Free Capacity
*   **Session Peak (Initial Tracking)**:
    *   Tracks the **High Watermark** of memory usage (`↑ 180MB`).
    *   Helps detect memory leaks or resource spikes.
    *   **Click to Reset**: Reset the peak counter to current usage.

### 2. Tech HUD Sidebar
A completely redesigned sidebar tab with a flat, data-dense "Tech HUD" aesthetic.
*   **Sparklines**: Real-time SVG charts for **Disk I/O** (Read/Write) and **Network Traffic** (Up/Down).
*   **Progress Bars**: Slim, color-coded bars (Green/Yellow/Red) for CPU, RAM, and Disk usage.
*   **Context Aware**: Clearly distinguishes between total system load and Node-RED's specific contribution.

### 3. Theme Support
*   **Modes**: **Dark** (Default), **Light**, and **Auto** (System Sync).
*   **Configurable**: Toggle themes via the sidebar Settings panel.

## Installation

Run the following command in your Node-RED user directory (typically `~/.node-red`):

```bash
npm install node-red-contrib-performance-monitor
```

Restart Node-RED:

```bash
node-red
```

## Usage

1.  Open the Node-RED Editor (`http://localhost:1880`).
2.  Open the **Sidebar** and select the **Performance** tab (Terminal Icon `>_`).
3.  The **Header Widget** will automatically appear in the top bar.

## Configuration

Click the **CONFIG** button in the sidebar to:
*   Change the **Refresh Interval** (1s - 5s).
*   Switch **Themes** (Dark / Light / Auto).

## License

MIT License.
