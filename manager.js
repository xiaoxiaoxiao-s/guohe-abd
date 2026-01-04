const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

// 1. 读取配置
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// 确保目录存在
if (!fs.existsSync(config.log_dir)) fs.mkdirSync(config.log_dir);
if (!fs.existsSync(config.pid_dir)) fs.mkdirSync(config.pid_dir);

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

// === 启动 Dashboard ===
async function startDashboard() {
  const dashboardPort = config.dashboard_port || 3000;
  const logBase = path.join(config.log_dir, "dashboard");

  // 检查是否已运行
  if (fs.existsSync(path.join(config.pid_dir, "dashboard.pid"))) {
    console.log(`[!] Dashboard 似乎已在运行，请先 stop。`);
    return;
  }

  console.log(`\n[+] 启动 Dashboard (端口: ${dashboardPort})`);
  console.log(`    访问地址: http://localhost:${dashboardPort}`);

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

// === 启动所有任务 ===
async function startAll() {
  console.log("=== 正在启动 Dashboard & WDA 服务 & 端口转发 & Web 服务器 ===");

  // 先启动 Dashboard
  await startDashboard();

  for (const device of config.devices) {
    if (!device.enable) {
      console.log(`[-] 跳过设备: ${device.name}`);
      continue;
    }

    const logBase = path.join(config.log_dir, device.name);

    // 检查是否已运行 (简单检查其中一个pid文件)
    if (fs.existsSync(path.join(config.pid_dir, `${device.name}_wda.pid`))) {
      console.log(`[!] ${device.name} 似乎已在运行，请先 stop。`);
      continue;
    }

    // 计算端口
    const WDA_PORT = device.local_port;
    const MJPEG_PORT = device.local_port + 1;
    const WEB_PORT = device.local_port + 2;

    console.log(`\n[+] 启动设备组: ${device.name}`);
    console.log(`    WDA 控制端口: ${WDA_PORT}`);
    console.log(`    视频流端口: ${MJPEG_PORT}`);
    console.log(`    Web 访问端口: ${WEB_PORT}`);
    console.log(`    访问地址: http://localhost:${WEB_PORT}`);

    // 1. 启动 iproxy (控制端口: 电脑端口 -> 手机8100端口)
    const iproxyCtrlCmd = `nohup iproxy ${WDA_PORT} 8100 -u ${device.udid} > "${logBase}_iproxy_ctrl.log" 2>&1 & echo $!`;
    await spawnProcess(iproxyCtrlCmd, device.name, "iproxy_ctrl");

    // 2. 启动 iproxy (视频端口: 电脑端口+1 -> 手机9100端口)
    const iproxyMjpegCmd = `nohup iproxy ${MJPEG_PORT} 9100 -u ${device.udid} > "${logBase}_iproxy_mjpeg.log" 2>&1 & echo $!`;
    await spawnProcess(iproxyMjpegCmd, device.name, "iproxy_mjpeg");

    // 3. 启动 xcodebuild (WDA 服务)
    const wdaCmd = `nohup xcodebuild -project "${config.project_path}" \
-scheme "${config.scheme}" \
-destination "platform=iOS,id=${device.udid}" \
-allowProvisioningUpdates \
test > "${logBase}_wda.log" 2>&1 & echo $!`;
    await spawnProcess(wdaCmd, device.name, "wda");

    // 4. 启动 Node.js Web 服务器
    const serverCmd = `nohup env PORT=${WEB_PORT} WDA_PORT=${WDA_PORT} MJPEG_PORT=${MJPEG_PORT} node "${path.join(
      __dirname,
      "server.js"
    )}" > "${logBase}_server.log" 2>&1 & echo $!`;
    await spawnProcess(serverCmd, device.name, "server");
  }

  const dashboardPort = config.dashboard_port || 3000;
  console.log("\n>>> 所有命令已发送。请等待约 10-30 秒让 WDA 初始化。");
  console.log(`>>> 访问 Dashboard: http://localhost:${dashboardPort}`);
  console.log(">>> 验证方式: curl http://localhost:<WDA_PORT>/status");
  console.log(">>> 访问 Web 界面: http://localhost:<WEB_PORT>");
}

// === 停止所有任务 ===
function stopAll() {
  console.log("=== 停止所有服务 (Dashboard + WDA + iproxy + server) ===");

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
if (action === "start") startAll();
else if (action === "stop") stopAll();
else if (action === "restart") {
  stopAll();
  setTimeout(startAll, 2000);
} else console.log("用法: node manager.js [start|stop|restart]");
