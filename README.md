# Node-RED Performance Monitor

<img src="main.png" width="600" alt="Performance Monitor Hero">

A powerful, native **Performance Monitor** sidebar for Node-RED. It provides real-time visibility into your Node-RED instance's health and system resources with a beautiful, integrated design.

**v1.1.0 - The Precision & UI Update**
- 🚀 **Zero Dependencies** (No binary compilation required)
- 🖥️ **Cross-Platform** (macOS, Windows, Linux, Alpine, Raspberry Pi)
- 🎨 **Component-Level Theming** (Matches your Node-RED theme)

---

## ✨ Features

### 🔍 Real-Time Monitoring
Monitor key metrics with sub-second precision:
- **CPU Load**: Diff-based process usage calculation.
- **Memory**: Detailed heap and RSS tracking to spot leaks.
- **Event Loop Lag**: Millisecond-level latency detection.
- **System Hardware**: Full system CPU, RAM, and Disk usage with live sparkline history.

### 📐 Smart Sidebar
The sidebar is designed for efficiency.

#### Expanded Mode
Detailed view with progress bars, precise values, and history charts.
<img src="pm_sidebar_extended.png" width="300" alt="Extended View">

#### Mini Mode
Collapse any section to save space. The **Live Value** stays visible in the header, and the **Chart** remains active.
<img src="pm_sidebar_closed.png" width="300" alt="Collapsed View">

---

## 🎨 Themes

Includes 4 stunning themes that layer on top of your Node-RED colors.

| **Classic** | **Funky** |
| :---: | :---: |
| <img src="pm_theme_classic.png" width="200" alt="Classic"> | <img src="pm_theme_funky.png" width="200" alt="Funky"> |
| *Seamless Integration* | *Vibrant & Playful* |

| **Matrix** | **Cyberpunk** |
| :---: | :---: |
| <img src="pm_theme_matrix.png" width="200" alt="Matrix"> | <img src="pm_theme_cyberpunk.png" width="200" alt="Cyberpunk"> |
| *Terminal Code Esthetic* | *Neon Future Style* |

---

## 📦 Installation

Run the following command in your Node-RED user directory (typically `~/.node-red`):

```bash
npm install node-red-contrib-performance-monitor
```

Restart Node-RED, and you will see a new **Dashboard** icon in the sidebar designated for Performance Monitoring.

---

## 🔧 Configuration

Access settings by clicking the **Settings** button in the sidebar toolbar.
- **Refresh Rate**: Adjust polling interval (default: 2s).
- **HUD Widget**: Toggle the top header widget visibility.
- **Theme Selection**: Choose your preferred visual style.

## 🤝 License
MIT
[![Buy Me a Coffee](https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSpFZv2hqhfcN1rlBUHmMTKaVSfcS3E2YVDNw&s)](https://www.buymeacoffee.com/muratcanberber)



