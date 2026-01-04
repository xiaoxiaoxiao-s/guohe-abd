# iOS 云真机控制台

一个基于 WebDriverAgent 的 iOS 设备远程控制平台，支持多设备管理、实时投屏、触摸操作等功能。

## 功能特性

- 📱 多设备管理：支持同时管理多个 iOS 设备
- 🖥️ 实时投屏：通过 Web 界面实时查看设备屏幕
- 🖱️ 触摸操作：支持点击、滑动、拖拽等操作
- 🎮 快捷操作：Home 键、多任务、方向滑动等
- 📊 Dashboard：统一管理所有设备，查看在线状态
- 🔄 设备控制：支持启动、停止、重新连接设备

## 前置要求

### 1. 系统要求

- macOS（必须，因为需要 Xcode 和 iOS 开发工具）
- Node.js >= 14.0.0
- npm 或 yarn

### 2. 必需工具

#### 安装 Xcode

```bash
# 从 App Store 安装 Xcode，或使用命令行工具
xcode-select --install
```

#### 安装 libimobiledevice 工具

```bash
# 使用 Homebrew 安装
brew install libimobiledevice

# 验证安装
idevice_id -l  # 应该能看到连接的设备 UDID
```

#### 安装 WebDriverAgent

```bash
# 克隆 WebDriverAgent 项目
git clone https://github.com/appium/WebDriverAgent.git
cd WebDriverAgent
./Scripts/bootstrap.sh
```

**重要**：需要在 Xcode 中配置 WebDriverAgent：

1. 用 Xcode 打开 `WebDriverAgent.xcodeproj`
2. 选择你的开发团队（Team）
3. 选择目标设备（Target Device）
4. 运行一次测试，确保 WebDriverAgent 可以正常安装到设备上

#### 安装 pm2（用于管理 Dashboard）

```bash
npm install -g pm2
```

### 3. 设备准备

1. 使用 USB 连接 iOS 设备到 Mac
2. 在设备上信任此电脑
3. 获取设备 UDID：
   ```bash
   idevice_id -l
   ```

## 安装步骤

### 1. 克隆或下载项目

```bash
cd /path/to/your/project
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置项目

编辑 `config.json` 文件：

```json
{
  "project_path": "/path/to/WebDriverAgent/WebDriverAgent.xcodeproj",
  "scheme": "WebDriverAgentRunner",
  "log_dir": "./logs",
  "pid_dir": "./pids",
  "dashboard_port": 3000,
  "devices": [
    {
      "name": "iPhone_13",
      "udid": "你的设备UDID",
      "local_port": 8100,
      "enable": true
    }
  ]
}
```

**配置说明**：

- `project_path`: WebDriverAgent.xcodeproj 的完整路径
- `scheme`: 通常是 "WebDriverAgentRunner"
- `dashboard_port`: Dashboard 服务端口（默认 3000）
- `devices`: 设备列表
  - `name`: 设备名称（自定义）
  - `udid`: 设备 UDID（通过 `idevice_id -l` 获取）
  - `local_port`: 设备的基础端口（每个设备需要 3 个连续端口）
    - `local_port`: WDA 控制端口
    - `local_port + 1`: 视频流端口
    - `local_port + 2`: Web 访问端口
  - `enable`: 是否启用此设备

**端口分配示例**：

- 设备 1：`local_port = 8100`
  - WDA 控制：8100
  - 视频流：8101
  - Web 访问：8102
- 设备 2：`local_port = 8200`
  - WDA 控制：8200
  - 视频流：8201
  - Web 访问：8202

## 运行项目

### 启动所有服务

```bash
node manager.js start
```

这会启动：

1. Dashboard 服务（端口 3000，可通过 pm2 管理）
2. 所有启用设备的服务：
   - iproxy 端口转发（WDA 和视频流）
   - WebDriverAgent 服务
   - Web 服务器

### 停止所有服务

```bash
node manager.js stop
```

### 重启所有服务

```bash
node manager.js restart
```

## 使用说明

### 1. 访问 Dashboard

启动服务后，在浏览器中访问：

```
http://localhost:3000
```

Dashboard 会显示所有配置的设备，包括：

- 设备名称和 UDID
- 在线/离线状态
- 访问链接
- 断开连接按钮（设备在线时显示）
- 重新连接按钮（设备离线时显示）

### 2. 访问设备控制界面

方式一：从 Dashboard 点击"进入投屏"按钮

方式二：直接访问设备对应的 Web 端口：

```
http://localhost:8102  # 假设设备 local_port 是 8100
```

### 3. 设备控制界面功能

- **点击**：在屏幕上点击任意位置
- **快速滑动**：快速拖动鼠标（< 0.5 秒）实现滑动
- **慢速拖拽**：慢速拖动鼠标（> 0.5 秒）实现拖拽
- **方向滑动按钮**：点击方向按钮实现快速滑动
- **Home 键**：返回桌面
- **多任务**：打开多任务切换器

## 目录结构

```
guohe-abd/
├── config.json              # 配置文件
├── manager.js               # 服务管理脚本
├── server.js                # 设备 Web 服务器
├── dashboard-server.js      # Dashboard 服务器
├── package.json             # 项目依赖
├── public/                  # 设备控制界面
│   └── index.html
├── dashboard/               # Dashboard 界面
│   └── index.html
├── logs/                    # 日志目录
│   ├── dashboard.log
│   └── {device_name}_*.log
└── pids/                    # PID 文件目录
    └── {device_name}_*.pid
```

## 常见问题

### 1. 设备连接失败

**问题**：无法连接到设备

**解决方案**：

- 检查设备是否通过 USB 连接
- 确认设备已信任此电脑
- 检查 UDID 是否正确：`idevice_id -l`
- 查看日志：`logs/{device_name}_iproxy_ctrl.log`

### 2. WebDriverAgent 启动失败

**问题**：WDA 服务无法启动

**解决方案**：

- 确认 WebDriverAgent 项目路径正确
- 在 Xcode 中运行一次 WebDriverAgent，确保可以正常安装
- 检查设备是否已信任开发者证书
- 查看日志：`logs/{device_name}_wda.log`

### 3. 端口被占用

**问题**：启动时提示端口被占用

**解决方案**：

```bash
# 查看端口占用
lsof -i :8100

# 停止占用端口的进程
kill -9 <PID>

# 或停止所有服务后重新启动
node manager.js stop
node manager.js start
```

### 4. Dashboard 无法访问

**问题**：无法访问 Dashboard

**解决方案**：

- 检查 Dashboard 是否启动：`pm2 list`
- 检查端口是否被占用：`lsof -i :3000`
- 查看 Dashboard 日志：`logs/dashboard.log`

### 5. 视频流无法显示

**问题**：投屏画面无法显示

**解决方案**：

- 等待 10-30 秒让 WDA 完全启动
- 检查视频流端口是否正常：`curl http://localhost:8101`
- 查看设备日志：`logs/{device_name}_server.log`
- 确认设备屏幕未锁定

### 6. 滑动操作延迟

**问题**：滑动操作响应慢

**解决方案**：

- 已优化滑动速度（150ms），如果仍慢可能是网络延迟
- 检查设备性能
- 查看服务器日志确认请求是否正常处理

## 开发说明

### 添加新设备

1. 获取设备 UDID：`idevice_id -l`
2. 在 `config.json` 的 `devices` 数组中添加新设备配置
3. 确保端口不冲突（每个设备需要 3 个连续端口）
4. 重启服务：`node manager.js restart`

### 查看日志

```bash
# Dashboard 日志
tail -f logs/dashboard.log

# 设备日志
tail -f logs/{device_name}_wda.log
tail -f logs/{device_name}_server.log
```

### 手动停止单个设备

```bash
# 查看进程 PID
cat pids/{device_name}_wda.pid

# 停止进程
kill -9 <PID>
```

## 许可证

ISC

## 贡献

欢迎提交 Issue 和 Pull Request！
