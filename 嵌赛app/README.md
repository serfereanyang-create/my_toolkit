# 实验室安全节点静态监控网站

这是一个不依赖后端、不依赖构建工具的静态网站骨架，用于先展示管理员监控页面结构。后续真实数据格式确定后，只需要修改 assets/app.js 中的数据适配层即可。

## 当前包含模块

- 系统总览状态
- 气体传感器实时卡片
- AI 视觉识别状态
- 风机、蜂鸣器、继电器等执行器状态
- 当前报警事件
- 设备运行状态
- 实时事件流
- 趋势图占位
- 阈值与策略占位

## 使用方式

直接用浏览器打开 index.html 即可预览。若要接入 ESP32-P4 的真实串口数据，先烧录固件，再启动本地桥接服务：

当前固件已经把 `SC16-CO` 一氧化碳传感器接入 ESP32-P4 的 UART1，并把真实 CO ppm 放到 `LABSAFE_JSON.coPpm` 后上传到网页。接线如下：

| SC16-CO | ESP32-P4 |
|---|---|
| Vin | 5V |
| GND | GND |
| TXD | GPIO32（ESP32-P4 RX） |
| RXD | GPIO33（ESP32-P4 TX） |

SC16-CO 串口参数为 `9600 8N1`；ESP32-P4 通过 USB 串口输出网页桥接用的 `LABSAFE_JSON:` 行，USB 串口波特率为 `115200`。

```powershell
cd D:\codex\my_toolkit\hello_p4\idf_test\ssd1309_esp32s3_demo_idf
idf.py -p COM9 flash

cd D:\codex\嵌赛app
node tools\labsafe_serial_bridge.mjs COM9 115200 8765
```

其中 `flash` 需要在已加载 ESP-IDF 环境的终端中执行；桥接服务不依赖 ESP-IDF，会直接读取 Windows 串口 `COM9`。如果开发板枚举为其他端口，把两处 `COM9` 改成实际端口即可。

桥接服务会监听 ESP32-P4 串口中以 `LABSAFE_JSON:` 开头的 JSON 行，并提供本地接口：

- `http://127.0.0.1:8765/health`
- `http://127.0.0.1:8765/snapshot`

网页会每秒轮询该接口；如果桥接服务未启动，会自动回退到演示数据。

后续可部署到 Vercel、Netlify、GitHub Pages 或任意静态网站服务。
