# pycamera / ESP32-Lite

这个目录现在保留 3 条路线，其中最贴近你当前需求的是：

- 电脑保存图片
- P4 + LCD 只显示进度

## 文件

### 1. `capture_to_pc.py`

电脑端抓图脚本。

作用：

- 从 WiFi camera 抓单张 JPEG
- 保存到电脑当前目录下的 `captured_images`
- 默认最多保存 `50` 张
- 每保存一张，通过串口发一条进度给 P4

默认进度格式：

```text
SAVE,<current>,<total>,<status>
```

例如：

```text
SAVE,12,50,OK
SAVE,50,50,DONE
```

### 2. `pycamera_pc_progress_lcd\pycamera_pc_progress_lcd.ino`

P4 + LCD 进度显示版。

作用：

- 不保存图片
- 只接收电脑通过 UART 发来的进度
- LCD 显示：
  - 当前已保存张数
  - 总目标张数
  - 状态
  - 进度条

### 3. `pycamera_wifi_lcd_monitor\pycamera_wifi_lcd_monitor.ino`

这个还是官方 WiFi 图传监视版。

作用：

- 配置 / 查询 ESP32-Lite WiFi
- 显示 `FW / STA IP / AP IP / last response`

适合查：

- 模块有没有启动
- 有没有拿到 IP
- WiFi 是否连通

## 现在推荐的方案

你当前目标是：

- 图片存到电脑
- LCD 只显示进度

那就直接用：

1. `capture_to_pc.py`
2. `pycamera_pc_progress_lcd.ino`

## 电脑端抓图脚本怎么用

打开：

- `capture_to_pc.py`

先改这些参数：

```python
CAPTURE_URL = "http://192.168.4.1/capture"
SAVE_COUNT = 50
SAVE_INTERVAL_SECONDS = 2.0
SERIAL_PORT = "COM9"
SERIAL_BAUD = 115200
SERIAL_ENABLED = False
```

说明：

- `CAPTURE_URL`
  - 改成你的 camera 实际抓拍地址
  - 这版默认先写成 `http://192.168.4.1/capture`
- `SERIAL_PORT`
  - 改成你电脑连接 P4 时看到的串口号
- `SERIAL_ENABLED`
  - 如果你要把进度发给 P4，就改成 `True`

脚本保存的图片目录是：

- `pycamera\captured_images`

也就是和这个 README 同目录下。

## P4 进度显示版接线

### 电脑 / USB串口 -> ESP32-P4

如果你要让电脑把进度发给 P4，需要有一条串口链路到 P4：

- `PC TX -> P4 GPIO47`
- `PC RX -> P4 GPIO46`
- `GND -> GND`

默认波特率：

- `115200`

### LCD -> ESP32-P4

- `CS -> GPIO5`
- `DC -> GPIO4`
- `RST -> GPIO3`
- `MOSI -> GPIO2`
- `SCLK -> GPIO1`
- `BLK -> GPIO20`

## 一句提醒

这套方案成不成，关键看一件事：

- 你的 WiFi camera 有没有一个能直接返回单张 JPEG 的抓拍 URL

如果 `CAPTURE_URL` 不对，脚本就抓不到图。

所以最先要确认的是：

- 在浏览器里访问哪个地址，能直接下载 / 显示一张 JPG

确认后把那个地址填进 `capture_to_pc.py`。
