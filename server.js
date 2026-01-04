const express = require("express");
const axios = require("axios");
const path = require("path");
const cors = require("cors");
const http = require("http");
const os = require("os");
const fs = require("fs");
const multer = require("multer");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const localtunnel = require("localtunnel");

// ==========================================
// 核心修改 1: 从环境变量读取端口配置（必须在文件开头）
// ==========================================
// 如果没传参数，就用默认值 (兼容单机模式)
const SERVER_PORT = process.env.PORT || 3000; // 网页访问端口
const WDA_PORT = process.env.WDA_PORT || 8100; // WDA 控制端口
const MJPEG_PORT = process.env.MJPEG_PORT || 9100; // 视频流端口

console.log(
  `🔧 配置加载: Web端口=${SERVER_PORT} | WDA端口=${WDA_PORT} | 视频端口=${MJPEG_PORT}`
);

// 构建动态 URL
const WDA_CTRL = `http://127.0.0.1:${WDA_PORT}`;
const MJPEG_URL = `http://127.0.0.1:${MJPEG_PORT}`;

const app = express();
app.use(cors());
app.use(express.json());

// 添加请求日志中间件（用于调试 GET 请求问题）
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    console.log(`[请求日志] ${req.method} ${req.path} - 端口: ${SERVER_PORT}`);
    console.log(`[请求日志] URL: ${req.url}, 原始URL: ${req.originalUrl}`);
  }
  next();
});

// 配置 multer 用于文件上传
const upload = multer({
  dest: path.join(__dirname, "uploads"), // 临时存储目录
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 最大 2GB
  },
});

// 确保上传目录存在
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ==========================================
// 文件上传接口: 将视频文件传输到 iOS 设备
// ==========================================
// 根据端口查找设备 UDID
function getDeviceUDID() {
  try {
    const configPath = path.join(__dirname, "config.json");
    if (!fs.existsSync(configPath)) {
      console.error(`[getDeviceUDID] 配置文件不存在: ${configPath}`);
      return null;
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    console.log(
      `[getDeviceUDID] 当前端口: SERVER_PORT=${SERVER_PORT}, WDA_PORT=${WDA_PORT}, MJPEG_PORT=${MJPEG_PORT}`
    );

    // 尝试多种匹配方式：
    // 1. 通过 WEB_PORT 匹配 (local_port + 2)
    let device = config.devices.find(
      (d) => d.enable && d.local_port + 2 === Number(SERVER_PORT)
    );

    // 2. 如果没找到，通过 WDA_PORT 匹配 (local_port)
    if (!device) {
      device = config.devices.find(
        (d) => d.enable && d.local_port === Number(WDA_PORT)
      );
    }

    // 3. 如果还没找到，通过 MJPEG_PORT 匹配 (local_port + 1)
    if (!device) {
      device = config.devices.find(
        (d) => d.enable && d.local_port + 1 === Number(MJPEG_PORT)
      );
    }

    if (device) {
      console.log(
        `[getDeviceUDID] 找到设备: ${device.name}, UDID: ${device.udid}`
      );
      return device.udid;
    } else {
      console.error(`[getDeviceUDID] 未找到匹配的设备。可用设备:`);
      config.devices.forEach((d) => {
        if (d.enable) {
          console.error(
            `  - ${d.name}: local_port=${d.local_port}, web_port=${
              d.local_port + 2
            }, wda_port=${d.local_port}, mjpeg_port=${d.local_port + 1}`
          );
        }
      });
      return null;
    }
  } catch (error) {
    console.error("读取设备配置失败:", error.message);
    return null;
  }
}

app.get("/api/tttt", async (req, res) => {
  try {
    const size = await getScreenSize();
    res.json(size);
  } catch (error) {
    console.error(`[API] ❌ 获取设备尺寸失败: ${error.message}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: "获取设备尺寸失败" });
  }
});

app.post("/api/upload", upload.single("video"), async (req, res) => {
  console.log(`[API] /api/upload 请求 - 端口: ${SERVER_PORT}`);
  try {
    if (!req.file) {
      return res.status(400).json({ error: "请选择要上传的文件" });
    }

    const udid = getDeviceUDID();
    if (!udid) {
      // 清理临时文件
      fs.unlinkSync(req.file.path);
      return res.status(500).json({
        error: "无法获取设备 UDID，请检查 config.json 配置",
      });
    }

    console.log(`📤 开始上传文件到设备 ${udid}: ${req.file.originalname}`);
    console.log(`    文件大小: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`    临时路径: ${req.file.path}`);

    // 方法1: 尝试使用 xcrun devicectl (iOS 17+)
    // 注意：devicectl 命令可能不存在，直接跳过
    try {
      // 先检查命令是否存在
      await execAsync(`which xcrun 2>&1`);
      const targetPath = `/private/var/mobile/Media/DCIM/100APPLE/${req.file.originalname}`;
      const { stdout, stderr } = await execAsync(
        `xcrun devicectl device install media --device ${udid} "${req.file.path}" "${targetPath}" 2>&1`
      );
      if (!stderr || stderr.includes("success") || stdout.includes("success")) {
        console.log(`✅ 文件上传成功 (devicectl)`);
        // 清理临时文件
        fs.unlinkSync(req.file.path);
        return res.json({
          success: true,
          message: `文件已成功传输到设备相册: ${req.file.originalname}`,
        });
      } else {
        throw new Error(stderr || "devicectl 执行失败");
      }
    } catch (devicectlError) {
      console.log(
        `⚠️ devicectl 方法不可用，尝试使用 ifuse: ${devicectlError.message}`
      );
    }

    // 方法2: 使用 ifuse 挂载设备文件系统
    const mountPoint = path.join(__dirname, "device_mount");
    try {
      // 确保挂载点存在
      if (!fs.existsSync(mountPoint)) {
        fs.mkdirSync(mountPoint, { recursive: true });
      }

      // 挂载设备
      await execAsync(`ifuse "${mountPoint}" -u ${udid} 2>&1`);
      console.log(`📂 设备已挂载到: ${mountPoint}`);

      // 复制文件到设备的 DCIM 目录（相册）
      const deviceDCIM = path.join(mountPoint, "DCIM", "100APPLE");
      if (!fs.existsSync(deviceDCIM)) {
        // 如果目录不存在，尝试创建或使用其他位置
        const deviceMedia = path.join(mountPoint, "Media");
        if (fs.existsSync(deviceMedia)) {
          const altDCIM = path.join(deviceMedia, "DCIM", "100APPLE");
          if (!fs.existsSync(altDCIM)) {
            fs.mkdirSync(altDCIM, { recursive: true });
          }
          const targetFile = path.join(altDCIM, req.file.originalname);
          fs.copyFileSync(req.file.path, targetFile);
          console.log(`✅ 文件已复制到: ${targetFile}`);
        } else {
          throw new Error("无法找到设备的 DCIM 目录");
        }
      } else {
        const targetFile = path.join(deviceDCIM, req.file.originalname);
        fs.copyFileSync(req.file.path, targetFile);
        console.log(`✅ 文件已复制到: ${targetFile}`);
      }

      // 卸载设备
      await execAsync(`umount "${mountPoint}" 2>&1`);
      console.log(`📂 设备已卸载`);

      // 清理临时文件
      fs.unlinkSync(req.file.path);

      return res.json({
        success: true,
        message: `文件已成功传输到设备相册: ${req.file.originalname}`,
      });
    } catch (ifuseError) {
      console.error(`❌ ifuse 方法失败: ${ifuseError.message}`);
      // 清理临时文件
      fs.unlinkSync(req.file.path);
      // 尝试卸载（如果挂载失败，这个命令会失败，但不会影响）
      try {
        await execAsync(`umount "${mountPoint}" 2>&1`);
      } catch (e) {}

      return res.status(500).json({
        error: "文件传输失败",
        message: `请确保已安装 libimobiledevice (brew install libimobiledevice) 或使用 iOS 17+ 设备支持 xcrun devicectl`,
        details: ifuseError.message,
      });
    }
  } catch (error) {
    console.error("文件上传失败:", error.message);
    // 清理临时文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({
      error: "文件上传失败",
      message: error.message,
    });
  }
});

let cachedSessionId = null;

// ==========================================
// 核心优化: 设置 WDA 压缩参数
// ==========================================
async function configureSettings(sessionId) {
  try {
    await axios.post(`${WDA_CTRL}/session/${sessionId}/appium/settings`, {
      settings: {
        mjpegServerScreenshotQuality: 30,
        mjpegServerFramerate: 30,
        mjpegScalingFactor: 50,
      },
    });
    console.log("✅ 画质优化配置已发送");
  } catch (e) {
    // 忽略不支持的错误
  }
}

// 获取 Session
async function getSessionId() {
  try {
    const statusRes = await axios.get(`${WDA_CTRL}/status`);
    if (statusRes.data.sessionId) {
      configureSettings(statusRes.data.sessionId);
      return statusRes.data.sessionId;
    }
  } catch (e) {}

  console.log("🔄 创建新 Session...");
  try {
    const createRes = await axios.post(`${WDA_CTRL}/session`, {
      capabilities: {
        alwaysMatch: {
          arguments: [],
          environment: {},
          shouldWaitForQuiescence: false,
        },
      },
    });
    cachedSessionId = createRes.data.sessionId;
    await configureSettings(cachedSessionId);
    return cachedSessionId;
  } catch (error) {
    console.error("❌ Session 创建失败:", error.message);
    throw error;
  }
}

// 获取屏幕尺寸
let DEVICE_SIZE = null;
async function getScreenSize() {
  if (DEVICE_SIZE) return DEVICE_SIZE;
  try {
    const sessionId = await getSessionId();
    const res = await axios.get(`${WDA_CTRL}/session/${sessionId}/window/rect`);
    DEVICE_SIZE = {
      width: res.data.value.width,
      height: res.data.value.height,
    };
    return DEVICE_SIZE;
  } catch (e) {
    return { width: 375, height: 812 };
  }
}

// ==========================================
// 💡 修正点: 视频流直接透传 (无缓冲)
// ==========================================
// 处理 OPTIONS 预检请求
app.options("/api/stream", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.status(200).end();
});

app.get("/api/stream", (req, res) => {
  // 先设置 CORS 头（必须在 writeHead 之前）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  // 使用原生 http 模块发起请求，建立直连通道
  const proxyReq = http.get(MJPEG_URL, (streamRes) => {
    // 1. 复制响应头，但确保 CORS 头不被覆盖
    const headers = { ...streamRes.headers };

    // 强制设置 CORS 头（覆盖上游可能存在的头）
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "*";

    // 保持 multipart/x-mixed-replace 内容类型
    res.writeHead(streamRes.statusCode, headers);

    // 2. 建立管道：WDA的数据 -> Node -> 前端 (不经过任何处理)
    streamRes.pipe(res);
  });

  // 错误处理
  proxyReq.on("error", (e) => {
    console.error("❌ 视频流转发失败:", e.message);
    // 确保错误响应也包含 CORS 头
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.status(500).end();
  });

  // 客户端断开时，销毁上游连接
  req.on("close", () => {
    proxyReq.destroy();
  });
});

// 点击接口
app.post("/api/tap", async (req, res) => {
  try {
    const { x, y, viewWidth, viewHeight } = req.body;
    const deviceSize = await getScreenSize();

    const realX = Math.round((x / viewWidth) * deviceSize.width);
    const realY = Math.round((y / viewHeight) * deviceSize.height);

    console.log(`🖱️ 点击: (${realX}, ${realY})`);

    const sessionId = await getSessionId();
    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: realX, y: realY },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 50 }, // 稍微按久一点点，防止误触
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    res.json({ success: true });
  } catch (error) {
    console.error("点击失败:", error.message);
    cachedSessionId = null;
    res.status(500).json({ error: "点击失败" });
  }
});

// ==========================================
// 新增接口: 滑动 / 拖拽 (Swipe)
// ==========================================
app.post("/api/swipe", async (req, res) => {
  try {
    const { startX, startY, endX, endY, viewWidth, viewHeight } = req.body;
    const deviceSize = await getScreenSize();

    // 1. 坐标换算 (起点和终点都要换算)
    const realStartX = Math.round((startX / viewWidth) * deviceSize.width);
    const realStartY = Math.round((startY / viewHeight) * deviceSize.height);
    const realEndX = Math.round((endX / viewWidth) * deviceSize.width);
    const realEndY = Math.round((endY / viewHeight) * deviceSize.height);

    console.log(
      `↔️ 滑动: (${realStartX},${realStartY}) -> (${realEndX},${realEndY})`
    );

    const sessionId = await getSessionId();

    // 2. 构建 W3C 滑动动作序列
    // 优化：减小duration到150ms，实现快速滑动
    const swipePromise = axios.post(
      `${WDA_CTRL}/session/${sessionId}/actions`,
      {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              {
                type: "pointerMove",
                duration: 0,
                x: realStartX,
                y: realStartY,
              },
              { type: "pointerDown", button: 0 },
              // duration 优化：减小到100ms，实现更快的滑动响应
              { type: "pointerMove", duration: 100, x: realEndX, y: realEndY },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      }
    );

    // 立即返回响应，不等待WDA操作完成（fire and forget）
    res.json({ success: true });

    // 异步处理错误（不阻塞响应）
    swipePromise.catch((error) => {
      console.error("滑动操作失败:", error.message);
    });
  } catch (error) {
    console.error("滑动失败:", error.message);
    res.status(500).json({ error: "滑动失败" });
  }
});

// ==========================================
// 新增接口: 拖拽 (Drag) - 用于移动图标等
// ==========================================
app.post("/api/drag", async (req, res) => {
  try {
    const { startX, startY, endX, endY, viewWidth, viewHeight } = req.body;
    const deviceSize = await getScreenSize();

    // 1. 坐标换算
    const realStartX = Math.round((startX / viewWidth) * deviceSize.width);
    const realStartY = Math.round((startY / viewHeight) * deviceSize.height);
    const realEndX = Math.round((endX / viewWidth) * deviceSize.width);
    const realEndY = Math.round((endY / viewHeight) * deviceSize.height);

    console.log(
      `✊ 拖拽: (${realStartX},${realStartY}) -> (${realEndX},${realEndY})`
    );

    const sessionId = await getSessionId();

    // 2. 构建 W3C 拖拽动作序列
    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: realStartX, y: realStartY },
            { type: "pointerDown", button: 0 },
            // 关键区别：按下后暂停 1000ms (即 1秒)，模拟长按选中
            { type: "pause", duration: 1000 },
            // 然后慢慢移动到终点 (1000ms)，防止甩飞
            { type: "pointerMove", duration: 1000, x: realEndX, y: realEndY },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    res.json({ success: true });
  } catch (error) {
    console.error("拖拽失败:", error.message);
    res.status(500).json({ error: "拖拽失败" });
  }
});

// 1. Home 键 (回桌面)
app.post("/api/home", async (req, res) => {
  try {
    console.log("🏠 执行 Home 键操作");
    // WDA 原生接口: /wda/homescreen
    // 这比用 swipe 上滑要极其稳定
    await axios.post(`${WDA_CTRL}/wda/homescreen`);
    res.json({ success: true });
  } catch (error) {
    console.error("Home键失败:", error.message);
    res.status(500).json({ error: "Failed" });
  }
});

// 2. 多任务/最近应用 (App Switcher)
app.post("/api/app_switcher", async (req, res) => {
  try {
    console.log("🗂 打开多任务后台");
    const deviceSize = await getScreenSize();
    const sessionId = await getSessionId();

    // 逻辑：从屏幕最底部中间，慢慢滑到屏幕中心，然后松开
    // 这就是 iOS 打开多任务的标准手势
    const startX = Math.round(deviceSize.width / 2);
    const startY = deviceSize.height - 5; // 最底部
    const endY = Math.round(deviceSize.height / 2); // 中间

    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: startX, y: startY },
            { type: "pointerDown", button: 0 },
            // 慢一点滑，持续 500ms
            { type: "pointerMove", duration: 500, x: startX, y: endY },
            // 关键：在中间停顿 500ms，触发多任务
            { type: "pause", duration: 500 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    res.json({ success: true });
  } catch (error) {
    console.error("多任务失败:", error.message);
    res.status(500).json({ error: "Failed" });
  }
});

// API: 获取设备屏幕尺寸（GET 接口）
app.get("/api/device/size", async (req, res) => {
  try {
    const size = await getScreenSize();
    res.json(size);
  } catch (error) {
    console.error(`[API] ❌ 获取设备尺寸失败: ${error.message}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: "获取设备尺寸失败" });
  }
});

// server.js 只提供 API 接口，不提供静态文件服务
// 静态文件由 dashboard-server.js 提供

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

app.listen(SERVER_PORT, "0.0.0.0", async () => {
  const localIP = getLocalIP();

  console.log(`🚀 服务已启动: http://0.0.0.0:${SERVER_PORT}`);
  console.log(`📱 本地访问: http://localhost:${SERVER_PORT}`);
  console.log(`🌐 外网访问: http://${localIP}:${SERVER_PORT}`);

  // // 启动 localtunnel（如果失败不影响主服务）
  // try {
  //   const tunnel = await localtunnel({
  //     port: SERVER_PORT, // port 应该是数字，不是 URL
  //   });
  //   console.log(`[🌍] Localtunnel 外网访问地址: ${tunnel.url}`);

  //   // 监听 tunnel 关闭事件
  //   tunnel.on("close", () => {
  //     console.log("[🌍] Localtunnel 已关闭");
  //   });
  // } catch (tunnelError) {
  //   console.warn(`[⚠️] Localtunnel 启动失败: ${tunnelError.message}`);
  //   console.warn(`[⚠️] 服务仍可正常使用，但无法通过 Localtunnel 外网访问`);
  // }
});
