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

// === 辅助函数：检查进程是否真的在运行 ===
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// === 辅助函数：清理无效的 PID 文件 ===
function cleanupStalePidFile(pidPath, processName) {
  if (!fs.existsSync(pidPath)) {
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim());
    if (!isProcessRunning(pid)) {
      console.log(
        `    [!] 清理无效的 PID 文件: ${processName} (PID ${pid} 已不存在)`
      );
      fs.unlinkSync(pidPath);
      return true;
    }
  } catch (e) {
    console.log(`    [!] 清理损坏的 PID 文件: ${processName}`);
    fs.unlinkSync(pidPath);
    return true;
  }

  return false;
}

// === 辅助函数：检查端口是否被占用 ===
function isPortInUse(port) {
  return new Promise((resolve) => {
    exec(`lsof -ti :${port}`, (error) => {
      resolve(!error);
    });
  });
}

// === 辅助函数：检查设备是否真的连接 ===
function isDeviceConnected(udid) {
  return new Promise((resolve) => {
    exec(`idevice_id -l`, (error, stdout) => {
      if (error) {
        // 如果 idevice_id 命令失败，假设设备未连接
        resolve(false);
        return;
      }
      // 检查 UDID 是否在连接的设备列表中
      const connectedDevices = stdout.trim().split("\n");
      resolve(connectedDevices.includes(udid));
    });
  });
}

// === 辅助函数：清理设备的所有进程 ===
async function cleanupDeviceProcesses(deviceName, pidDir) {
  const processTypes = ["iproxy_ctrl", "iproxy_mjpeg", "wda", "server"];
  let cleanedCount = 0;

  for (const type of processTypes) {
    const pidFile = path.join(__dirname, pidDir, `${deviceName}_${type}.pid`);
    if (fs.existsSync(pidFile)) {
      try {
        const pid = fs.readFileSync(pidFile, "utf8").trim();
        process.kill(pid, "SIGTERM");
        fs.unlinkSync(pidFile);
        cleanedCount++;
        console.log(`    [!] 已清理 ${deviceName}_${type} (PID: ${pid})`);
      } catch (e) {
        // 忽略进程不存在的错误
        if (fs.existsSync(pidFile)) {
          fs.unlinkSync(pidFile);
          cleanedCount++;
        }
      }
    }
  }

  return cleanedCount;
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

    // 计算端口
    const WDA_PORT = device.local_port;
    const MJPEG_PORT = device.local_port + 1;
    const WEB_PORT = device.local_port + 2;

    // 检查是否已运行 (检查所有相关的 pid 文件，并验证进程是否真的在运行)
    const pidDir = config.pid_dir || "./pids";
    const serverPidPath = path.join(
      __dirname,
      pidDir,
      `${deviceName}_server.pid`
    );
    const wdaPidPath = path.join(__dirname, pidDir, `${deviceName}_wda.pid`);
    const iproxyCtrlPidPath = path.join(
      __dirname,
      pidDir,
      `${deviceName}_iproxy_ctrl.pid`
    );
    const iproxyMjpegPidPath = path.join(
      __dirname,
      pidDir,
      `${deviceName}_iproxy_mjpeg.pid`
    );

    // 清理无效的 PID 文件
    cleanupStalePidFile(serverPidPath, `${deviceName}_server`);
    cleanupStalePidFile(wdaPidPath, `${deviceName}_wda`);
    cleanupStalePidFile(iproxyCtrlPidPath, `${deviceName}_iproxy_ctrl`);
    cleanupStalePidFile(iproxyMjpegPidPath, `${deviceName}_iproxy_mjpeg`);

    // 检查设备是否真的连接（如果设备断开，应该清理所有进程）
    const deviceConnected = await isDeviceConnected(device.udid);
    if (!deviceConnected) {
      console.log(
        `    [!] 设备 ${deviceName} (UDID: ${device.udid}) 未连接，强制清理所有残留进程...`
      );
      const cleanedCount = await cleanupDeviceProcesses(deviceName, pidDir);

      // 强制清理占用端口的进程
      if (await isPortInUse(WDA_PORT)) {
        exec(`lsof -ti :${WDA_PORT} | xargs kill -9 2>/dev/null || true`);
      }
      if (await isPortInUse(MJPEG_PORT)) {
        exec(`lsof -ti :${MJPEG_PORT} | xargs kill -9 2>/dev/null || true`);
      }
      if (await isPortInUse(WEB_PORT)) {
        exec(`lsof -ti :${WEB_PORT} | xargs kill -9 2>/dev/null || true`);
      }

      // 等待端口释放
      let retries = 20;
      while (
        retries > 0 &&
        ((await isPortInUse(WDA_PORT)) ||
          (await isPortInUse(MJPEG_PORT)) ||
          (await isPortInUse(WEB_PORT)))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        retries--;
      }

      console.log(
        `    [!] 已清理 ${cleanedCount} 个残留进程，设备可以重新启动`
      );
      // 继续启动流程，不返回错误
    }

    // 检查端口是否被占用（即使 PID 文件不存在）
    const webPortInUse = await isPortInUse(WEB_PORT);
    const wdaPortInUse = await isPortInUse(WDA_PORT);
    const mjpegPortInUse = await isPortInUse(MJPEG_PORT);

    // 检查是否有任何相关进程在运行（PID 文件存在且进程在运行）
    const serverRunning = fs.existsSync(serverPidPath);
    const wdaRunning = fs.existsSync(wdaPidPath);
    const iproxyCtrlRunning = fs.existsSync(iproxyCtrlPidPath);
    const iproxyMjpegRunning = fs.existsSync(iproxyMjpegPidPath);

    // 关键进程检查：只有当 wda 和 server 都在运行时，才阻止启动
    // 如果只有 iproxy 在运行（说明 xcode 启动失败），允许重新启动
    const criticalProcessRunning = serverRunning || wdaRunning;

    // 如果关键进程在运行，或者 web 端口被占用（说明 server 在运行），阻止启动
    // 但如果设备未连接，我们已经清理了所有进程，所以这里不应该阻止
    if (deviceConnected && (criticalProcessRunning || webPortInUse)) {
      const issues = [];
      if (serverRunning) issues.push(`进程文件: ${deviceName}_server.pid`);
      if (wdaRunning) issues.push(`进程文件: ${deviceName}_wda.pid`);
      if (webPortInUse) issues.push(`端口 ${WEB_PORT} 已被占用`);

      return res.status(400).json({
        error: "设备已在运行中",
        message: "检测到关键进程正在运行或端口被占用，请先停止设备",
        issues: issues,
      });
    }

    // 如果只有 iproxy 在运行（xcode 启动失败的情况），清理 iproxy 进程以便重新启动
    if (
      iproxyCtrlRunning ||
      iproxyMjpegRunning ||
      wdaPortInUse ||
      mjpegPortInUse
    ) {
      console.log(`    [!] 检测到残留的 iproxy 进程，正在清理...`);

      // 清理 iproxy 进程
      if (iproxyCtrlRunning) {
        try {
          const pid = fs.readFileSync(iproxyCtrlPidPath, "utf8").trim();
          process.kill(pid, "SIGTERM");
          fs.unlinkSync(iproxyCtrlPidPath);
          console.log(`    [!] 已清理 ${deviceName}_iproxy_ctrl (PID: ${pid})`);
        } catch (e) {
          if (fs.existsSync(iproxyCtrlPidPath)) {
            fs.unlinkSync(iproxyCtrlPidPath);
          }
        }
      }

      if (iproxyMjpegRunning) {
        try {
          const pid = fs.readFileSync(iproxyMjpegPidPath, "utf8").trim();
          process.kill(pid, "SIGTERM");
          fs.unlinkSync(iproxyMjpegPidPath);
          console.log(
            `    [!] 已清理 ${deviceName}_iproxy_mjpeg (PID: ${pid})`
          );
        } catch (e) {
          if (fs.existsSync(iproxyMjpegPidPath)) {
            fs.unlinkSync(iproxyMjpegPidPath);
          }
        }
      }

      // 等待端口释放（最多等待 2 秒）
      let retries = 20;
      while (
        retries > 0 &&
        ((await isPortInUse(WDA_PORT)) || (await isPortInUse(MJPEG_PORT)))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        retries--;
      }

      console.log(`    [!] iproxy 清理完成，继续启动流程`);
    }

    // 确保目录存在
    if (!fs.existsSync(path.join(__dirname, config.log_dir))) {
      fs.mkdirSync(path.join(__dirname, config.log_dir), { recursive: true });
    }
    if (!fs.existsSync(path.join(__dirname, pidDir))) {
      fs.mkdirSync(path.join(__dirname, pidDir), { recursive: true });
    }

    const logBase = path.join(__dirname, config.log_dir, deviceName);

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

    // 3. 启动 xcodebuild (WDA 服务)
    const wdaCmd = `nohup xcodebuild -project "${config.project_path}" \
      -scheme "${config.scheme}" \
      -destination "platform=iOS,id=${device.udid}" \
      -allowProvisioningUpdates \
      test > "${logBase}_wda.log" 2>&1 & echo $!`;
    await spawnProcess(wdaCmd, deviceName, "wda", config);

    // 4. 启动 Node.js Web 服务器
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

// API: 重新连接设备（不验证，直接关闭所有进程并重新启动）
app.post("/api/device/reconnect", async (req, res) => {
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

    const pidDir = config.pid_dir || "./pids";

    // 计算端口
    const WDA_PORT = device.local_port;
    const MJPEG_PORT = device.local_port + 1;
    const WEB_PORT = device.local_port + 2;

    console.log(`\n[🔄] 重新连接设备: ${deviceName}`);
    console.log(`    [!] 正在关闭所有进程...`);

    // 1. 清理所有进程（不验证，直接清理）
    const cleanedCount = await cleanupDeviceProcesses(deviceName, pidDir);

    // 2. 强制清理占用端口的进程
    if (await isPortInUse(WDA_PORT)) {
      exec(`lsof -ti :${WDA_PORT} | xargs kill -9 2>/dev/null || true`);
    }
    if (await isPortInUse(MJPEG_PORT)) {
      exec(`lsof -ti :${MJPEG_PORT} | xargs kill -9 2>/dev/null || true`);
    }
    if (await isPortInUse(WEB_PORT)) {
      exec(`lsof -ti :${WEB_PORT} | xargs kill -9 2>/dev/null || true`);
    }

    // 3. 等待端口释放（最多等待 3 秒）
    let retries = 30;
    while (
      retries > 0 &&
      ((await isPortInUse(WDA_PORT)) ||
        (await isPortInUse(MJPEG_PORT)) ||
        (await isPortInUse(WEB_PORT)))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      retries--;
    }

    console.log(`    [!] 已清理 ${cleanedCount} 个进程，端口已释放`);

    // 4. 确保目录存在
    if (!fs.existsSync(path.join(__dirname, config.log_dir))) {
      fs.mkdirSync(path.join(__dirname, config.log_dir), { recursive: true });
    }
    if (!fs.existsSync(path.join(__dirname, pidDir))) {
      fs.mkdirSync(path.join(__dirname, pidDir), { recursive: true });
    }

    const logBase = path.join(__dirname, config.log_dir, deviceName);

    console.log(`    [+] 正在重新启动所有进程...`);
    console.log(`    WDA 控制端口: ${WDA_PORT}`);
    console.log(`    视频流端口: ${MJPEG_PORT}`);
    console.log(`    Web 访问端口: ${WEB_PORT}`);

    // 5. 重新启动所有进程
    // 1. 启动 iproxy (控制端口)
    const iproxyCtrlCmd = `nohup iproxy ${WDA_PORT} 8100 -u ${device.udid} > "${logBase}_iproxy_ctrl.log" 2>&1 & echo $!`;
    await spawnProcess(iproxyCtrlCmd, deviceName, "iproxy_ctrl", config);

    // 2. 启动 iproxy (视频端口)
    const iproxyMjpegCmd = `nohup iproxy ${MJPEG_PORT} 9100 -u ${device.udid} > "${logBase}_iproxy_mjpeg.log" 2>&1 & echo $!`;
    await spawnProcess(iproxyMjpegCmd, deviceName, "iproxy_mjpeg", config);

    // 3. 启动 xcodebuild (WDA 服务)
    const wdaCmd = `nohup xcodebuild -project "${config.project_path}" \
      -scheme "${config.scheme}" \
      -destination "platform=iOS,id=${device.udid}" \
      -allowProvisioningUpdates \
      test > "${logBase}_wda.log" 2>&1 & echo $!`;
    await spawnProcess(wdaCmd, deviceName, "wda", config);

    // 4. 启动 Node.js Web 服务器
    const serverCmd = `nohup env PORT=${WEB_PORT} WDA_PORT=${WDA_PORT} MJPEG_PORT=${MJPEG_PORT} node "${path.join(
      __dirname,
      "server.js"
    )}" > "${logBase}_server.log" 2>&1 & echo $!`;
    await spawnProcess(serverCmd, deviceName, "server", config);

    console.log(`    [✅] 设备 ${deviceName} 重新连接完成`);

    res.json({
      success: true,
      message: `设备 ${deviceName} 已重新连接，请等待约 10-30 秒让 WDA 初始化`,
      webPort: WEB_PORT,
    });
  } catch (error) {
    console.error("重新连接设备失败:", error.message);
    res.status(500).json({ error: "重新连接设备失败", message: error.message });
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
