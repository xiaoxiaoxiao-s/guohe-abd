const express = require("express");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const { exec } = require("child_process");
const os = require("os");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
app.use(cors());

app.use("/proxy/:targetPort", (req, res, next) => {
  const targetPort = req.params.targetPort;
  // 创建动态代理
  createProxyMiddleware({
    target: `http://127.0.0.1:${targetPort}`, // 转发目标
    changeOrigin: true,
    pathRewrite: {
      [`^/proxy/${targetPort}`]: "", // 去掉 URL 中的 /proxy/端口号 前缀
    },
    // 关键: 处理 MJPEG 视频流不缓冲
    onProxyRes: (proxyRes, req, res) => {
      if (req.url.includes("/stream")) {
        proxyRes.headers["connection"] = "keep-alive";
        proxyRes.headers["content-type"] =
          "multipart/x-mixed-replace; boundary=--boundary";
      }
    },
    onError: (err, req, res) => {
      console.error(`代理错误 (目标端口 ${targetPort}):`, err.message);
      res.status(500).send("Proxy Error");
    },
  })(req, res, next);
});

app.use(express.json());

// 提供 dashboard 静态文件
app.use(express.static(path.join(__dirname, "dashboard")));

// 读取配置
function getConfig() {
  const configPath = path.join(__dirname, "config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

// API: 获取配置列表（供 dashboard 使用）
app.get("/api/config", (req, res) => {
  try {
    const config = getConfig();

    // 返回设备列表，并计算每个设备的端口
    const devices = config.devices.map((device) => ({
      name: device.name,
      udid: device.udid,
      local_port: device.local_port,
      enable: device.enable,
      wda_port: device.local_port,
      mjpeg_port: device.local_port + 1,
      web_port: device.local_port + 2,
    }));

    res.json({ devices });
  } catch (error) {
    console.error("读取配置失败:", error.message);
    res.status(500).json({ error: "读取配置失败", message: error.message });
  }
});

// 辅助函数：启动单个后台进程
function spawnProcess(cmd, name, type, config) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`    [${type}] 启动失败: ${error.message}`);
        resolve(null);
        return;
      }
      const pid = stdout.trim();
      if (pid) {
        const pidFile = path.join(
          __dirname,
          config.pid_dir,
          `${name}_${type}.pid`
        );
        fs.writeFileSync(pidFile, pid);
        console.log(`    [${type}] 启动成功 PID: ${pid}`);
        resolve(pid);
      } else {
        resolve(null);
      }
    });
  });
}

// API: 停止单个设备
app.post("/api/device/stop", (req, res) => {
  try {
    const { deviceName } = req.body;

    if (!deviceName) {
      return res.status(400).json({ error: "缺少设备名称" });
    }

    const config = getConfig();
    const pidDir = config.pid_dir || "./pids";

    // 停止该设备的所有相关进程
    const processTypes = ["iproxy_ctrl", "iproxy_mjpeg", "wda", "server"];
    let stoppedCount = 0;

    processTypes.forEach((type) => {
      const pidFile = path.join(__dirname, pidDir, `${deviceName}_${type}.pid`);
      if (fs.existsSync(pidFile)) {
        try {
          const pid = fs.readFileSync(pidFile, "utf8").trim();
          process.kill(pid, "SIGTERM");
          fs.unlinkSync(pidFile);
          stoppedCount++;
          console.log(`已停止 ${deviceName}_${type} (PID: ${pid})`);
        } catch (e) {
          // 忽略进程不存在的错误
          if (e.code !== "ESRCH") {
            console.error(`停止 ${deviceName}_${type} 时出错:`, e.message);
          }
          // 即使出错也删除 pid 文件
          if (fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
          }
        }
      }
    });

    res.json({
      success: true,
      message: `已停止设备 ${deviceName} 的 ${stoppedCount} 个进程`,
      stoppedCount,
    });
  } catch (error) {
    console.error("停止设备失败:", error.message);
    res.status(500).json({ error: "停止设备失败", message: error.message });
  }
});

// API: 启动单个设备
app.post("/api/device/start", async (req, res) => {
  try {
    const { deviceName } = req.body;

    if (!deviceName) {
      return res.status(400).json({ error: "缺少设备名称" });
    }

    const config = getConfig();
    const device = config.devices.find((d) => d.name === deviceName);

    if (!device) {
      return res.status(404).json({ error: "设备不存在" });
    }

    if (!device.enable) {
      return res.status(400).json({ error: "设备未启用" });
    }

    // 检查是否已运行
    const pidDir = config.pid_dir || "./pids";
    if (
      fs.existsSync(path.join(__dirname, pidDir, `${deviceName}_server.pid`))
    ) {
      return res.status(400).json({ error: "设备已在运行中" });
    }

    // 确保目录存在
    if (!fs.existsSync(path.join(__dirname, config.log_dir))) {
      fs.mkdirSync(path.join(__dirname, config.log_dir), { recursive: true });
    }
    if (!fs.existsSync(path.join(__dirname, pidDir))) {
      fs.mkdirSync(path.join(__dirname, pidDir), { recursive: true });
    }

    const logBase = path.join(__dirname, config.log_dir, deviceName);

    // 计算端口
    const WDA_PORT = device.local_port;
    const MJPEG_PORT = device.local_port + 1;
    const WEB_PORT = device.local_port + 2;

    console.log(`\n[+] 启动设备: ${deviceName}`);
    console.log(`    WDA 控制端口: ${WDA_PORT}`);
    console.log(`    视频流端口: ${MJPEG_PORT}`);
    console.log(`    Web 访问端口: ${WEB_PORT}`);

    // 1. 启动 iproxy (控制端口)
    const iproxyCtrlCmd = `nohup iproxy ${WDA_PORT} 8100 -u ${device.udid} > "${logBase}_iproxy_ctrl.log" 2>&1 & echo $!`;
    await spawnProcess(iproxyCtrlCmd, deviceName, "iproxy_ctrl", config);

    // 2. 启动 iproxy (视频端口)
    const iproxyMjpegCmd = `nohup iproxy ${MJPEG_PORT} 9100 -u ${device.udid} > "${logBase}_iproxy_mjpeg.log" 2>&1 & echo $!`;
    await spawnProcess(iproxyMjpegCmd, deviceName, "iproxy_mjpeg", config);

    // 3. 启动 Node.js Web 服务器
    const serverCmd = `nohup env PORT=${WEB_PORT} WDA_PORT=${WDA_PORT} MJPEG_PORT=${MJPEG_PORT} node "${path.join(
      __dirname,
      "server.js"
    )}" > "${logBase}_server.log" 2>&1 & echo $!`;
    await spawnProcess(serverCmd, deviceName, "server", config);

    res.json({
      success: true,
      message: `设备 ${deviceName} 启动命令已发送，请等待约 10-30 秒让 WDA 初始化`,
      webPort: WEB_PORT,
    });
  } catch (error) {
    console.error("启动设备失败:", error.message);
    res.status(500).json({ error: "启动设备失败", message: error.message });
  }
});

// 设备控制页面路由（通过端口参数区分设备）
app.get("/device", (req, res) => {
  const port = req.query.port;
  if (!port) {
    return res.status(400).send("缺少端口参数");
  }
  res.sendFile(path.join(__dirname, "dashboard", "device.html"));
});

// 确保根路径返回 dashboard/index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "index.html"));
});

// 获取本机 IP 地址
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过内部（即 127.0.0.1）和非 IPv4 地址
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  const localIP = getLocalIP();
  console.log(`📊 Dashboard 服务已启动: http://localhost:${PORT}`);
  console.log(`🌐 外网访问: http://${localIP}:${PORT}`);
});
