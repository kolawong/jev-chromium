# Jev Chromium

> **基于 TypeSafe Jev 超快视觉决策大模型与 Beautiful UI 现代设计系统的 AI 原生浏览器应用**  
> *An AI-native autonomous browser powered by TypeSafe Jev ultrafast visual decision model and Beautiful UI.*

[![Electron](https://img.shields.io/badge/Electron-34.x-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![UI](https://img.shields.io/badge/Design_System-Beautiful_UI-6366F1)](https://www.beautifului.dev/)
[![Model](https://img.shields.io/badge/Engine-TypeSafe_Jev_1.0-0EA5E9)](https://typesafe.ai)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 核心特性 (Key Features)

### 1. 毫秒级极速视觉决策 (Sub-Second Decision Latency)
- **告别臃肿的慢速智能体**：传统的 Playwright/CDP 网页 Agent 通常需要 5~15 秒才能完成一步动作决策，且容易遭遇 Token 爆炸。
- **Jev 原生元素级推理**：深度融合 TypeSafe Jev 多模态视觉模型，直接对 DOM 可操作元素、空间坐标与用户意图进行联合建模，单步决策仅需 **~700ms - 1.5s**，实现流畅自如的实时自动化浏览。

### 2. Beautiful UI 现代设计系统 (Modern AI-Native UI)
- **56px 一体化 Prompt Bar**：将自然语言指令输入、标准网址导航与 Agent 控制器无缝融合，极致释放网页可视区域。
- **微交互与呼吸动效**：配备 3x3 像素矩阵呼吸灯（`.pixel-grid`）、运行态旋转渐变圈、完成态弹性对勾，毫秒级高精度思考计时器。
- **任务状态卡片 (Task Rows)**：标准化轻量操作胶囊（`[CLICK]`、`[FILL]`、`[NAVIGATE]`、`[DONE]`），支持点击展开查看模型置信度分布与目标元素属性。

### 3. 原生架构与抽屉中心 (Native Electron Architecture)
- **WebContentsView 硬件加速**：基于 Electron 最新 `WebContentsView` 架构，与 Chromium 渲染引擎直接贴合，支持完整的现代网页功能、弹窗拦截与安全沙箱。
- **抽屉式设置与监控中心**：侧边抽屉无缝整合 `[执行步骤]`、`[运行日志]` 与 `[设置中心]`，彻底规避原生视图图层遮挡问题。

### 4. 动态模型配置与热更新 (Multi-Model Support & Hot-Reload)
- **双引擎协同工作**：
  - **核心动作决策**：TypeSafe Jev (`jev-latest`)，负责点击、聚焦、跳转、完成等动作规划；
  - **内容智能生成**：兼容 OpenAI 规范的辅助大模型（默认预设 **MiniMax**，亦可一键切换为 **DeepSeek**、**OpenAI** 或自定义网关），负责智能分析并补全搜索词、表单字段等文本。
- **即时测试与持久化**：界面内支持一键测试 Jev 与文本模型连通性（附带真实延迟反馈），配置热更新并持久化回写至 `.env`。

---

## ️ 运行流程架构 (Architecture)

```mermaid
flowchart TD
    User([用户输入目标 / Prompt]) --> Bar[一体化 Prompt Bar 触发]
    Bar --> Engine[Agent Runner 控制中枢]
    
    subgraph BrowserCore [Chromium 浏览器视图 WebContentsView]
        Page[活跃目标网页]
        DOM[DOM 树 & 视口可操作元素]
        CDP[CDP / Input 事件驱动注入]
    end
    
    subgraph Observe [感知层 Snapshot]
        Page --> DOM
        DOM --> Extract[提取交互元素 / 角色 / 标签 / 坐标]
    end
    
    subgraph Brain [决策与生成引擎]
        Extract --> JevModel[TypeSafe Jev 视觉决策模型]
        User -.-> JevModel
        JevModel --> Decision{决策类型判断}
        Decision -- "CLICK / NAV / DONE" --> Actuator[动作执行器]
        Decision -- "TYPE_TEXT" --> TextLLM[辅助文本生成模型\nMiniMax / DeepSeek / OpenAI]
        TextLLM --> Actuator
    end
    
    Actuator --> CDP
    CDP --> Page
    Actuator --> UIState[更新抽屉状态卡片 & 日志表格]
    UIState --> NextCycle{任务是否完成 [DONE]?}
    NextCycle -- 否 --> Extract
    NextCycle -- 是 --> Finished([任务达成])
```

---

## 快速上手 (Quick Start)

### 1. 环境准备 (Prerequisites)
- [Node.js](https://nodejs.org/) >= 18.0.0
- npm >= 9.0.0
- macOS / Windows / Linux

### 2. 克隆与安装 (Installation)
```bash
# 进入项目目录
cd /Users/kola/jev-chromium

# 安装依赖
npm install
```

### 3. 配置环境变量 (Configuration)
复制配置文件模板：
```bash
cp .env.example .env
```
编辑 `.env` 填入您的 API Key（亦可在启动应用后通过界面右侧的 `[设置]` 页面直观配置并一键测试）：
```env
# 1. TypeSafe Jev API Key
TYPESAFE_API_KEY=apikey_xxxxxxxxx
TYPESAFE_MODEL=jev-latest

# 2. 辅助文本生成大模型配置 (可选: MiniMax, DeepSeek, OpenAI)
TEXT_MODEL_API_KEY=sk-xxxxxxxxx
TEXT_MODEL_BASE_URL=https://api.minimaxi.com/v1
TEXT_MODEL=MiniMax-M3
TEXT_MODEL_REASONING=none
```

### 4. 运行应用 (Run Application)
```bash
npm start
```

---

## ️ 核心界面使用指南 (User Interface Guide)

| 区域 | 功能说明 | 交互技巧 |
| :--- | :--- | :--- |
| **Prompt Bar** | 顶栏一体化输入中枢 | 输入自然语言任务（如 `在 Google 搜索最新 AI 资讯并打开首条`）或网址后按回车执行 |
| **主按钮** | 控制 Agent 状态 | 空闲时显示 **运行**，运行时为 **暂停**，暂停时为 **继续** |
| **单步调试** | 单步观察 | 点击 `单步` 按钮触发单次观察与决策，适合排查复杂表单流程 |
| **侧边抽屉** | 实时轨迹与日志 | 点击右上角菜单按钮可展开/折叠右侧 Drawer 面板 |
| **设置中心** | 模型管理与连通测试 | 点击顶栏 `Jev 1.0` 胶囊或右上角齿轮图标，即可一键进入配置面板 |

---

## 项目结构 (Repository Structure)

```text
jev-chromium/
├── src/
│   ├── main.js             # Electron 主进程：窗口管理、WebContentsView 挂载、IPC 调度
│   ├── preload.js          # 安全上下文桥接：向渲染层暴露 window.agentAPI
│   ├── agent/
│   │   ├── runner.js       # Agent 核心执行中枢：生命周期驱动与 CDP 自动化交互
│   │   ├── snapshot.js     # 页面感知与 DOM 状态快照提取（元素编号、属性清洗）
│   │   ├── model.js        # TypeSafe Jev API 与辅助文本模型网关调用（内置 DNS 容灾）
│   │   ├── config.js       # 系统配置中心：内存热重载、连接延迟测试、.env 持久化
│   │   ├── logger.js       # 结构化多级别运行日志系统
│   │   └── questions.js    # 交互式动态问题生成器
│   └── renderer/
│       ├── index.html      # Beautiful UI 原生渲染结构
│       ├── styles.css      # OKLCH 色彩体系、设计规范与动效样式表
│       └── renderer.js     # 渲染层逻辑：状态机驱动、任务流折叠、日志筛选
├── scripts/
│   ├── test-model.js       # Jev API 离线连通性测试脚本
│   └── test-baidu-flight.js# 携程/航旅自动化场景测试脚本
├── .env.example            # 环境变量配置模板
├── .gitignore              # Git 敏感信息与临时文件忽略列表
├── package.json            # 项目配置与脚本入口
└── README.md               # 项目完整说明文档
```

---

## ️ 环境变量详解 (Environment Variables)

| 变量名 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `TYPESAFE_API_KEY` | *(无)* | TypeSafe Jev 官方 API Key（核心视觉模型必需） |
| `TYPESAFE_MODEL` | `jev-latest` | Jev 决策模型版本（如 `jev-latest`） |
| `TEXT_MODEL_API_KEY` | *(无)* | 辅助文本大模型 API Key（用于表单填充推断） |
| `TEXT_MODEL_BASE_URL` | `https://api.minimaxi.com/v1` | 文本模型 OpenAI 兼容接口地址 |
| `TEXT_MODEL` | `MiniMax-M3` | 文本模型名称（支持 `MiniMax-M3`, `deepseek-chat`, `gpt-4o-mini` 等） |
| `TEXT_MODEL_REASONING`| `none` | 推理模式参数（`none` / `low` / `high`） |

---

## ️ 常用开发命令 (Development Scripts)

```bash
# 启动应用
npm start

# 独立测试 Jev 决策模型连接
npm run test:model

# 验证核心 JS 语法规范
node --check src/main.js src/preload.js src/renderer/renderer.js src/agent/*.js
```

---

## 开源许可证 (License)

本项目遵循 [MIT License](LICENSE) 开源协议。
