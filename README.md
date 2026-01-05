# iOS 云真机控制台

一个基于 WebDriverAgent 的 iOS 设备远程控制平台，支持多设备管理、实时投屏、触摸操作等功能。

## 功能特性

- 📱 多设备管理：支持同时管理多个 iOS 设备
- 🖥️ 实时投屏：通过 Web 界面实时查看设备屏幕
- 🖱️ 触摸操作：支持点击、滑动、拖拽等操作
- 🎮 快捷操作：Home 键、多任务、方向滑动等
- 📊 Dashboard：统一管理所有设备，查看在线状态
- 🔄 设备控制：支持启动、停止、重新连接设备
- 🌐 Cpolar 内网穿透：可选启用，支持通过公网访问服务（需指定关键词）

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

#### 安装 Cpolar（可选，用于内网穿透）

如果需要使用内网穿透功能，需要安装 cpolar：

```bash
# 访问 https://www.cpolar.com/ 下载并安装
# 或使用 Homebrew（如果可用）
brew install cpolar
```

安装后需要配置认证令牌（authtoken），参考 [Cpolar 官方文档](https://www.cpolar.com/docs)。

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

**基础启动**（不启用 cpolar）：

```bash
node manager.js start
```

**启动并启用 Cpolar 内网穿透**：

```bash
node manager.js start cpolar
# 或
node manager.js start --cpolar
```

启动顺序：

1. Dashboard 服务（端口 3000，通过 pm2 管理）
2. 所有启用设备的服务（串行启动）：
   - iproxy 端口转发（WDA 控制端口）
   - iproxy 端口转发（视频流端口）
   - WebDriverAgent 服务
   - Web 服务器
3. **最后执行** Cpolar（如果指定了 `cpolar` 关键词）

> 💡 **注意**：Cpolar 会在所有服务启动完成后才执行，确保所有服务都已就绪。

### 停止所有服务

```bash
node manager.js stop
```

这会停止所有服务，包括：
- Dashboard（通过 pm2）
- 所有设备的 WDA、iproxy、Web 服务器
- Cpolar（如果已启动）

### 重启所有服务

**基础重启**：

```bash
node manager.js restart
```

**重启并启用 Cpolar**：

```bash
node manager.js restart cpolar
# 或
node manager.js restart --cpolar
```

## 使用说明

### 1. 访问 Dashboard

启动服务后，在浏览器中访问：

**本地访问**：

```
http://localhost:3000
```

**外网访问**：

```
http://<your-server-ip>:3000
```

**通过 Cpolar 访问**（如果启用了 cpolar）：

启动 cpolar 后，会生成一个公网访问地址，可以在 cpolar 的 Web 界面查看，或查看日志：

```bash
tail -f logs/cpolar.log
```

> 💡 **提示**：所有服务默认监听 `0.0.0.0`，支持外网访问。请确保防火墙已开放相应端口。

Dashboard 会显示所有配置的设备，包括：

- 设备名称和 UDID
- 在线/离线状态
- 访问链接
- 断开连接按钮（设备在线时显示）
- 重新连接按钮（设备离线时显示）

### 2. 访问设备控制界面

方式一：从 Dashboard 点击"进入投屏"按钮

方式二：直接访问设备对应的 Web 端口：

**本地访问**：

```
http://localhost:8102  # 假设设备 local_port 是 8100
```

**外网访问**：

```
http://<your-server-ip>:8102
```

**通过 Cpolar 访问**：

如果启用了 cpolar，可以通过 cpolar 生成的公网地址访问。

> 💡 **提示**：Dashboard 会自动检测当前访问地址（本地或外网），并生成对应的设备链接。

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
├── dashboard/               # Dashboard 界面
│   ├── index.html
│   └── device.html
├── logs/                    # 日志目录
│   ├── dashboard.log        # Dashboard 日志
│   ├── dashboard_error.log  # Dashboard 错误日志
│   ├── dashboard_out.log    # Dashboard 输出日志
│   ├── cpolar.log           # Cpolar 日志（如果启用）
│   └── {device_name}_*.log  # 设备相关日志
│       ├── {device_name}_iproxy_ctrl.log    # iproxy 控制端口日志
│       ├── {device_name}_iproxy_mjpeg.log   # iproxy 视频流日志
│       ├── {device_name}_wda.log            # WDA 服务日志
│       └── {device_name}_server.log         # Web 服务器日志
└── pids/                    # PID 文件目录
    ├── dashboard.pid        # Dashboard PID
    ├── cpolar_cpolar.pid    # Cpolar PID（如果启用）
    └── {device_name}_*.pid  # 设备进程 PID
```

## 外网访问配置

### 方式一：直接外网访问（需要公网 IP）

如果服务器有公网 IP，可以直接通过 IP 地址访问。

#### 防火墙设置

**macOS**：

```bash
# 查看防火墙状态
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# 开放端口（以 3000 为例）
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/sbin/httpd
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp /usr/sbin/httpd
```

**Linux**：

```bash
# Ubuntu/Debian
sudo ufw allow 3000/tcp
sudo ufw allow 8100:8200/tcp  # 根据设备数量调整端口范围

# CentOS/RHEL
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --permanent --add-port=8100-8200/tcp
sudo firewall-cmd --reload
```

### 方式二：使用 Cpolar 内网穿透（推荐，无需公网 IP）

Cpolar 可以创建内网穿透隧道，无需公网 IP 即可通过公网访问。

#### 使用步骤

1. **安装 Cpolar**（参考前置要求）

2. **配置认证令牌**：

   ```bash
   cpolar authtoken <your-authtoken>
   ```

3. **启动服务时启用 Cpolar**：

   ```bash
   node manager.js start cpolar
   ```

4. **查看公网地址**：

   ```bash
   # 查看 cpolar 日志获取公网地址
   tail -f logs/cpolar.log
   
   # 或访问 cpolar Web 界面
   # 默认地址：http://127.0.0.1:4040
   ```

5. **通过公网地址访问**：

   使用 cpolar 生成的公网地址访问 Dashboard 和设备控制界面。

> 💡 **提示**：Cpolar 免费版会生成随机域名，每次重启可能会变化。付费版可以绑定固定域名。

### 端口说明

- **Dashboard 端口**：`dashboard_port`（默认 3000）
- **Cpolar 端口**：3000（转发 Dashboard 端口）
- **设备端口**：每个设备需要 3 个连续端口
  - `local_port`：WDA 控制端口
  - `local_port + 1`：视频流端口
  - `local_port + 2`：Web 访问端口

### 安全建议

⚠️ **重要**：外网访问时请注意安全：

1. **使用 HTTPS**：建议使用反向代理（如 Nginx）配置 HTTPS
2. **访问控制**：使用防火墙限制访问 IP
3. **认证机制**：考虑添加登录认证（当前版本无认证）
4. **VPN 访问**：建议通过 VPN 访问，而不是直接暴露到公网
5. **Cpolar 安全**：使用 Cpolar 时，建议配置访问密码或 IP 白名单

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
- 查看 Dashboard 日志：`logs/dashboard.log`、`logs/dashboard_error.log`

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

### 7. Cpolar 启动失败

**问题**：Cpolar 无法启动或无法访问

**解决方案**：

- 确认已安装 cpolar：`which cpolar` 或 `cpolar version`
- 检查是否配置了认证令牌：`cpolar authtoken <token>`
- 查看 Cpolar 日志：`tail -f logs/cpolar.log`
- 确认 Dashboard 端口（3000）未被占用
- 检查 Cpolar Web 界面：`http://127.0.0.1:4040`

### 8. Cpolar 公网地址无法访问

**问题**：通过 Cpolar 生成的公网地址无法访问

**解决方案**：

- 确认 Cpolar 服务正在运行：检查 `pids/cpolar_cpolar.pid`
- 查看 Cpolar 日志确认隧道是否建立成功
- 检查防火墙是否阻止了 Cpolar 连接
- 确认 Cpolar 账户状态正常（免费版有流量限制）

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
tail -f logs/dashboard_error.log

# 设备日志
tail -f logs/{device_name}_wda.log
tail -f logs/{device_name}_server.log
tail -f logs/{device_name}_iproxy_ctrl.log
tail -f logs/{device_name}_iproxy_mjpeg.log

# Cpolar 日志（如果启用）
tail -f logs/cpolar.log
```

### 手动停止单个设备

```bash
# 查看进程 PID
cat pids/{device_name}_wda.pid

# 停止进程
kill -9 <PID>
```

### 手动停止 Cpolar

```bash
# 查看 Cpolar PID
cat pids/cpolar_cpolar.pid

# 停止 Cpolar
kill -9 <PID>
```

## 命令参考

### manager.js 命令

```bash
# 启动服务（不启用 cpolar）
node manager.js start

# 启动服务并启用 cpolar
node manager.js start cpolar
node manager.js start --cpolar

# 停止所有服务
node manager.js stop

# 重启服务（不启用 cpolar）
node manager.js restart

# 重启服务并启用 cpolar
node manager.js restart cpolar
node manager.js restart --cpolar
```

## 许可证

ISC

## 贡献

欢迎提交 Issue 和 Pull Request！
