const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const os = require("os");

// 1. 读取配置
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// 确保目录存在
if (!fs.existsSync(config.log_dir)) fs.mkdirSync(config.log_dir);
if (!fs.existsSync(config.pid_dir)) fs.mkdirSync(config.pid_dir);

// === 辅助函数：检查进程是否真的在运行 ===
function isProcessRunning(pid) {
  try {
    // 发送信号 0 来检查进程是否存在（不会实际终止进程）
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
    // 如果读取失败，也清理掉
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
      resolve(!error); // 如果命令成功（找到进程），说明端口被占用
    });
  });
}

// === 辅助函数：启动单个后台进程 ===
function spawnProcess(cmd, name, type) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`    [${type}] 启动失败: ${error}`);
        resolve(null);
        return;
      }
      const pid = stdout.trim();
      if (pid) {
        const pidFile = path.join(config.pid_dir, `${name}_${type}.pid`);
        fs.writeFileSync(pidFile, pid);
        console.log(`    [${type}] 启动成功 PID: ${pid}`);
        resolve(pid);
      } else {
        resolve(null);
      }
    });
  });
}

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

// === 启动 Dashboard ===
async function startDashboard() {
  const dashboardPort = config.dashboard_port || 3000;
  const logBase = path.join(config.log_dir, "dashboard");
  const localIP = getLocalIP();

  // 检查是否已运行
  if (fs.existsSync(path.join(config.pid_dir, "dashboard.pid"))) {
    console.log(`[!] Dashboard 似乎已在运行，请先 stop。`);
    return;
  }

  console.log(`\n[+] 启动 Dashboard (端口: ${dashboardPort})`);
  console.log(`    本地访问: http://localhost:${dashboardPort}`);
  console.log(`    外网访问: http://${localIP}:${dashboardPort}`);

  // 使用 pm2 启动 dashboard
  // 先检查是否已存在，如果存在则先删除
  exec("pm2 delete dashboard 2>/dev/null", () => {
    // 忽略错误，可能不存在
  });

  const dashboardCmd = `PORT=${dashboardPort} pm2 start "${path.join(
    __dirname,
    "dashboard-server.js"
  )}" --name dashboard --no-autorestart --log "${logBase}.log" --error "${logBase}_error.log" --output "${logBase}_out.log"`;

  return new Promise((resolve, reject) => {
    exec(dashboardCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`    [dashboard] 启动失败: ${error.message}`);
        console.error(`    提示: 请确保已安装 pm2 (npm install -g pm2)`);
        resolve(null);
        return;
      }

      // pm2 启动后，获取进程信息
      setTimeout(() => {
        exec(`pm2 jlist`, (err, output) => {
          if (!err) {
            try {
              const processes = JSON.parse(output);
              const dashboardProcess = processes.find(
                (p) => p.name === "dashboard"
              );
              if (dashboardProcess && dashboardProcess.pid) {
                const pidFile = path.join(config.pid_dir, "dashboard.pid");
                fs.writeFileSync(pidFile, dashboardProcess.pid.toString());
                console.log(
                  `    [dashboard] 启动成功 PID: ${dashboardProcess.pid}`
                );
              } else {
                console.log(`    [dashboard] 启动成功 (PM2 管理)`);
              }
            } catch (e) {
              console.log(`    [dashboard] 启动成功 (PM2 管理)`);
            }
          } else {
            console.log(`    [dashboard] 启动成功 (PM2 管理)`);
          }
          resolve(null);
        });
      }, 1000);
    });
  });
}

// === 启动 Cpolar ===
async function startCpolar() {
  const cpolarPort = 3000;
  const logBase = path.join(config.log_dir, "cpolar");

  // 检查是否已运行
  if (fs.existsSync(path.join(config.pid_dir, "cpolar_cpolar.pid"))) {
    console.log(`[!] Cpolar 似乎已在运行，请先 stop。`);
    return;
  }

  console.log(`\n[+] 启动 Cpolar (端口: ${cpolarPort})`);

  const cpolarCmd = `nohup cpolar http ${cpolarPort} > "${logBase}.log" 2>&1 & echo $!`;
  await spawnProcess(cpolarCmd, "cpolar", "cpolar");

  console.log(`    [cpolar] 已启动，日志: ${logBase}.log`);
}

// === 启动所有任务 ===
async function startAll(enableCpolar = false) {
  console.log("=== 正在启动 Dashboard & 端口转发 & Web 服务器 ===");

  // 先启动 Dashboard
  await startDashboard();

  for (const device of config.devices) {
    if (!device.enable) {
      console.log(`[-] 跳过设备: ${device.name}`);
      continue;
    }

    const logBase = path.join(config.log_dir, device.name);

    // 计算端口
    const WDA_PORT = device.local_port;
    const MJPEG_PORT = device.local_port + 1;
    const WEB_PORT = device.local_port + 2;

    // 检查是否已运行 (检查所有相关的 pid 文件，并验证进程是否真的在运行)
    const serverPidPath = path.join(
      config.pid_dir,
      `${device.name}_server.pid`
    );
    const iproxyCtrlPidPath = path.join(
      config.pid_dir,
      `${device.name}_iproxy_ctrl.pid`
    );
    const iproxyMjpegPidPath = path.join(
      config.pid_dir,
      `${device.name}_iproxy_mjpeg.pid`
    );

    // 清理无效的 PID 文件
    cleanupStalePidFile(serverPidPath, `${device.name}_server`);
    cleanupStalePidFile(iproxyCtrlPidPath, `${device.name}_iproxy_ctrl`);
    cleanupStalePidFile(iproxyMjpegPidPath, `${device.name}_iproxy_mjpeg`);

    // 检查端口是否被占用（即使 PID 文件不存在）
    const webPortInUse = await isPortInUse(WEB_PORT);
    const wdaPortInUse = await isPortInUse(WDA_PORT);
    const mjpegPortInUse = await isPortInUse(MJPEG_PORT);

    // 检查是否有任何相关进程在运行（PID 文件存在且进程在运行）
    const serverRunning = fs.existsSync(serverPidPath);
    const iproxyCtrlRunning = fs.existsSync(iproxyCtrlPidPath);
    const iproxyMjpegRunning = fs.existsSync(iproxyMjpegPidPath);

    if (
      serverRunning ||
      iproxyCtrlRunning ||
      iproxyMjpegRunning ||
      webPortInUse ||
      wdaPortInUse ||
      mjpegPortInUse
    ) {
      console.log(`[!] ${device.name} 似乎已在运行，请先 stop。`);
      if (serverRunning) {
        console.log(`    检测到进程文件: ${device.name}_server.pid`);
      }
      if (iproxyCtrlRunning) {
        console.log(`    检测到进程文件: ${device.name}_iproxy_ctrl.pid`);
      }
      if (iproxyMjpegRunning) {
        console.log(`    检测到进程文件: ${device.name}_iproxy_mjpeg.pid`);
      }
      if (webPortInUse) {
        console.log(`    端口 ${WEB_PORT} 已被占用`);
      }
      if (wdaPortInUse) {
        console.log(`    端口 ${WDA_PORT} 已被占用`);
      }
      if (mjpegPortInUse) {
        console.log(`    端口 ${MJPEG_PORT} 已被占用`);
      }
      continue;
    }

    const localIP = getLocalIP();
    console.log(`\n[+] 启动设备组: ${device.name}`);
    console.log(`    WDA 控制端口: ${WDA_PORT}`);
    console.log(`    视频流端口: ${MJPEG_PORT}`);
    console.log(`    Web 访问端口: ${WEB_PORT}`);
    console.log(`    本地访问: http://localhost:${WEB_PORT}`);
    console.log(`    外网访问: http://${localIP}:${WEB_PORT}`);

    // 1. 启动 iproxy (控制端口: 电脑端口 -> 手机8100端口)
    const iproxyCtrlCmd = `nohup iproxy ${WDA_PORT} 8100 -u ${device.udid} > "${logBase}_iproxy_ctrl.log" 2>&1 & echo $!`;
    await spawnProcess(iproxyCtrlCmd, device.name, "iproxy_ctrl");

    // 2. 启动 iproxy (视频端口: 电脑端口+1 -> 手机9100端口)
    const iproxyMjpegCmd = `nohup iproxy ${MJPEG_PORT} 9100 -u ${device.udid} > "${logBase}_iproxy_mjpeg.log" 2>&1 & echo $!`;
    await spawnProcess(iproxyMjpegCmd, device.name, "iproxy_mjpeg");

    // 3. 启动 xcodebuild (WDA 服务) - 已禁用
    // const wdaCmd = `nohup xcodebuild -project "${config.project_path}" \
    // -scheme "${config.scheme}" \
    // -destination "platform=iOS,id=${device.udid}" \
    // -allowProvisioningUpdates \
    // test > "${logBase}_wda.log" 2>&1 & echo $!`;
    // await spawnProcess(wdaCmd, device.name, "wda");

    // 4. 启动 Node.js Web 服务器
    const serverCmd = `nohup env PORT=${WEB_PORT} WDA_PORT=${WDA_PORT} MJPEG_PORT=${MJPEG_PORT} node "${path.join(
      __dirname,
      "server.js"
    )}" > "${logBase}_server.log" 2>&1 & echo $!`;
    await spawnProcess(serverCmd, device.name, "server");
  }

  const dashboardPort = config.dashboard_port || 3000;
  const localIP = getLocalIP();

  console.log("\n>>> 所有服务启动命令已发送。");
  console.log(`>>> 访问 Dashboard:`);
  console.log(`    本地: http://localhost:${dashboardPort}`);
  console.log(`    外网: http://${localIP}:${dashboardPort}`);
  console.log(">>> 验证方式: curl http://localhost:<WDA_PORT>/status");
  console.log(">>> 访问 Web 界面:");
  console.log(`    本地: http://localhost:<WEB_PORT>`);
  console.log(`    外网: http://${localIP}:<WEB_PORT>`);

  // 等待所有服务启动完成后再执行 cpolar（如果指定了关键词）
  if (enableCpolar) {
    console.log("\n>>> 所有服务已启动完成，现在启动 Cpolar...");
    await startCpolar();
    console.log(">>> Cpolar 启动完成");
  }
}

// === 停止所有任务 ===
function stopAll() {
  console.log("=== 停止所有服务 (Dashboard + iproxy + server + cpolar) ===");

  // 停止 Dashboard (使用 pm2)
  const dashboardPidPath = path.join(config.pid_dir, "dashboard.pid");
  if (fs.existsSync(dashboardPidPath)) {
    try {
      exec("pm2 stop dashboard 2>/dev/null", (error) => {
        if (!error) {
          console.log(`[-] 已停止 Dashboard`);
        }
      });
      exec("pm2 delete dashboard 2>/dev/null", () => {
        // 忽略错误
      });
      fs.unlinkSync(dashboardPidPath);
    } catch (e) {
      // 忽略错误，继续执行
    }
  } else {
    // 即使没有 pid 文件，也尝试停止 pm2 进程
    exec("pm2 stop dashboard 2>/dev/null", () => {});
    exec("pm2 delete dashboard 2>/dev/null", () => {});
  }

  if (!fs.existsSync(config.pid_dir)) {
    console.log("[-] 没有找到运行中的进程");
    return;
  }

  const files = fs.readdirSync(config.pid_dir);
  let stoppedCount = 0;

  files.forEach((file) => {
    if (file.endsWith(".pid")) {
      const pidPath = path.join(config.pid_dir, file);
      try {
        const pid = fs.readFileSync(pidPath, "utf8").trim();
        process.kill(pid, "SIGTERM");
        console.log(`[-] 已停止进程 ${file.replace(".pid", "")} (PID: ${pid})`);
        stoppedCount++;
        fs.unlinkSync(pidPath);
      } catch (e) {
        // 忽略进程不存在的错误
        if (e.code !== "ESRCH") {
          console.log(
            `[!] 停止进程 ${file.replace(".pid", "")} 时出错: ${e.message}`
          );
        }
        fs.unlinkSync(pidPath);
      }
    }
  });

  if (stoppedCount === 0) {
    console.log("[-] 没有运行中的进程需要停止");
  } else {
    console.log(`\n✅ 已停止 ${stoppedCount} 个进程`);
  }
}

// === 主入口 ===
const action = process.argv[2];
const keyword = process.argv[3]; // 获取第三个参数作为关键词

if (action === "start") {
  // 检查是否有 cpolar 关键词
  const enableCpolar = keyword === "cpolar" || keyword === "--cpolar";
  startAll(enableCpolar);
} else if (action === "stop") {
  stopAll();
} else if (action === "restart") {
  stopAll();
  setTimeout(() => {
    const enableCpolar = keyword === "cpolar" || keyword === "--cpolar";
    startAll(enableCpolar);
  }, 2000);
} else {
  console.log("用法: node manager.js [start|stop|restart] [cpolar]");
  console.log("示例: node manager.js start cpolar  # 启动并执行 cpolar");
}
