<p align="center">
  <img src="docs/logo.png" width="300" alt="极简飞行棋 Logo">
</p>

<p align="center">
  <b>一款由ZTMYO个人开发的极简风格、高颜值的网页飞行棋游戏。</b>
</p>

<p align="center">
  <a href="https://chess.shiliu.space/">
    <img src="https://img.shields.io/badge/立即试玩-chess.shiliu.space-A6D8B7?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZlcnNpb249IjEiIHdpZHRoPSI2MDAiIGhlaWdodD0iNjAwIj48cGF0aCBkPSJNMTI5IDExMWMtNTUgNC05MyA2Ni05MyA3OEwwIDM5OGMtMiA3MCAzNiA5MiA2OSA5MWgxYzc5IDAgODctNTcgMTMwLTEyOGgyMDFjNDMgNzEgNTAgMTI4IDEyOSAxMjhoMWMzMyAxIDcxLTIxIDY5LTkxbC0zNi0yMDljMC0xMi00MC03OC05OC03OGgtMTBjLTYzIDAtOTIgMzUtOTIgNDJIMjM2YzAtNy0yOS00Mi05Mi00MmgtMTV6IiBmaWxsPSIjZmZmIi8+PC9zdmc+&logoColor=white" alt="Play Now">
  </a>
  <img src="https://img.shields.io/badge/version-v1.0.0-A6D8B7?style=for-the-badge" alt="Version">
</p>

<p align="center">
  <img src="docs/game.png" width="900" alt="游戏界面预览" style="border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">
  <p align="center">游戏预览</p>
</p>

> **声明**  
> 本项目基于 [GPLv3 协议](./LICENSE)，免费开源，仅供学习交流，禁止转卖，谨防受骗。如需商用请保留版权信息，确保合法合规使用，运营风险自负，与作者无关。

---

### 核心特性

#### 三大游戏模式
- **在线联机**：基于 WebSocket 实现的实时对战。支持创建私密/公开房间，具备完整的房间管理系统。玩家可以在局内发送表情互动、实时文字聊天。
- **人机对战**：内置智能 AI 算法。提供**简单**与**困难**两级难度，困难 AI 会分析场上局势（如击败概率、终点距离等）进行决策。支持随时开启/关闭 AI 托管，并提供**加速模式**以大幅提升游戏节奏。（详见 [AI 决策流程逻辑](docs/AI决策.md)）
- **本地多人**：支持 2-4 人在同一设备上进行游戏，适合线下好友聚会，完全不依赖网络连接。

#### 创新道具模式
在道具模式下，击败对手棋子可获得积分（详见 [积分点折算公式](docs/能量点折算公式.md)）。积攒积分可兑换以下四大强力道具，极大增加了游戏的策略深度：
- **盲盒**：随机补给道具，在积分不足时可能成为逆转局势的关键。
- **传送门**：将棋子随机传送到地图上的空位置，可能快速前进，也可能面临倒退风险。
- **多面骰子**：突破传统 6 点限制，随机投摇到 1-12 点，实现超远距离跨越。
- **遥控骰子**：允许玩家自由选择下一次投掷的 1-6 任意点数，精准实现击败或到达关键格。

#### 欢乐模式
欢乐模式大幅降低了对抗的挫败感，带来更轻松愉快的游戏体验：
- **碰撞奖励**：棋子落在其他玩家棋子上时不再将其送回基地，而是根据敌方棋子数量奖励前进步数（每颗敌方棋子奖励 2 步），并自动连锁触发下一次碰撞检测。
- **积分享受**：道具模式下碰撞同样可获得积分奖励。
- **连投不惩罚**：连续三次摇到6 点时不会受到"所有棋子回基地"的惩罚，而是获得连投奖励继续回合。
- **叠子不阻挡**：跳子和飞棋路径上的叠子不会阻挡移动，飞棋终点叠子也不会触发撞机回基地。

#### 实时观战
- **观战模式**：支持通过房间列表直接进入正在进行的对局，以“上帝视角”实时观摩场上战况。

#### 深度数据分析与称号系统
- **过程统计**：实时记录每位玩家的移动距离、击败次数、投掷点数等情况。
- **趋势分析**：游戏结束后，通过折线图展示各玩家的完成度演变趋势，复盘整局局势。
- **称号系统**：根据单局表现授予称号，详见 [称号列表](docs/称号.md)

#### 移动端深度优化
- **触控优化**：移除了移动端浏览器原生的 300ms 点击延迟，确保操作反馈如丝般顺滑。
- **响应式布局**：界面针对不同屏幕尺寸进行适配，在手机浏览器上自动调整 UI 元素大小，保证操作便捷性。

#### 后台管理系统
- **实时监控**：提供专用的管理面板，可实时查看服务器运行状态、在线人数、房间列表及活跃会话详情。

---

### 技术亮点

- **高性能渲染**：大量使用 SVG 矢量图形绘制棋盘与棋子，配合 CSS3 滤镜（feGaussianBlur）实现霓虹发光效果，在保证高颜值的同时兼顾渲染性能。
- **硬件加速**：关键 UI 组件开启 GPU 合成加速，减少移动端 CPU 负载，解决交互滞后感。
- **轻量级后端架构**：
  - **无数据库设计**：所有实时对战状态、房间信息及游戏数据均通过 Node.js 内存管理，极大地降低了服务器部署成本与维护复杂度。提供 [管理 API](docs/API.md) 进行状态查询。
  - **高可用重连机制**：严密的掉线处理逻辑，支持玩家意外断线后的快速重连。重连后可瞬间恢复游戏数据。
  - **智能 AI 接管系统**：玩家离线或思考超时时自动切换至 AI 托管，确保对局不因个别玩家的行为而中断。
  - **物理隔断与迁移优化**：支持玩家在不同房间/游戏间静默迁移。通过底层的“物理隔断”清理技术，杜绝了房间切换时的消息泄漏与会话冲突。
  - **WebSocket 状态同步**：基于 WebSocket 实现极低延迟的双向通信，确保多人联机时的实时性与同步一致性。
- **纯粹技术栈**：前端不依赖任何重量级框架，使用原生 JavaScript (ES6+)、CSS 变量和标准 Web API 开发，具有极高的运行效率和兼容性。

---

### 快速开始

#### 1. 环境准备
确保你的环境中安装了 [Node.js](https://nodejs.org/)。

#### 2. 克隆与安装
```bash
git clone https://github.com/ZTMYO/MinimalistAeroplaneChess
cd minimalist-aeroplane-chess
npm install
```

#### 3. 运行项目
```bash
# 根目录一键启动前后端
npm run dev
```

#### 4. 目录结构
- `frontend/`：前端源码（Vite 多页应用）
- `backend/`：后端服务（Express + WebSocket）
- `shared/`：前后端共用的规则引擎与 AI 决策，两边引用同一份实现
- `tools/`：命令行调试脚本，仅在手动执行时使用，不参与运行时

#### 5. 创建违规词库
项目的聊天与昵称过滤会读取本地文件 `frontend/assets/违规词库.txt`。该文件已在 `.gitignore` 中忽略，不会被提交到远程仓库。

请在本地手动创建该文件，每行一个词，例如：

```txt
违规词1
违规词2
```

如需手动分开启动：

```bash
# 终端 1：后端
cd backend && npm run dev

# 终端 2：前端
cd frontend && npm run dev
```

---

### 生产部署

项目无需构建，直接运行源码。服务器上只需上传 `frontend/`、`backend/`、`shared/`、`package.json`、`package-lock.json`（不要传 `node_modules/` 与 `.env`）。

```bash
# 首次部署
cd minimalist-aeroplane-chess
npm install --omit=dev

cd backend
cp .env.example .env 2>/dev/null || true   # 无示例文件则手动创建并填入 PORT
pm2 start server.cjs --name aeroplane-chess
pm2 save && pm2 startup

# 后续更新
cd minimalist-aeroplane-chess
git pull
npm install --omit=dev          # 依赖有变动时执行
pm2 restart aeroplane-chess
```

注意：`server.cjs` 通过 `dotenv` 从当前工作目录读取 `.env`，因此启动 pm2 时需处于 `backend/` 目录。若前置 Nginx，反代时需转发 WebSocket 的 Upgrade 头，否则联机握手失败。

---

### 致谢与灵感

本项目在开发过程中，深受 [Hullqin 的桌游合集](https://game.hullqin.cn/) 的启发，在此表示由衷的感谢。

本项目在游戏规则的设计上（详见[游戏规则说明](docs/游戏规则.md)），参考了[飞行棋百度百科](https://baike.baidu.com/item/%E9%A3%9E%E8%A1%8C%E6%A3%8B)的启发，在此表示由衷的感谢。

本项目使用 [Trae](https://trae.cn/) 进行设计与开发,在此表示由衷的感谢。

---

<p align="center">Made with ❤️ by ZTMYO</p>
