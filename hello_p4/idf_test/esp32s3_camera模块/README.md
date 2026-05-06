# ESP32-S3 Camera Benchmark

这个工程用于测试 ESP32-S3 摄像头模块的最大处理速度，测试内容包括：

- 摄像头取帧耗时
- 灰度缩放耗时
- 模拟推理前处理/轻量计算耗时
- 估算可达到 FPS
- 打印 heap / PSRAM 剩余空间

## 工程位置

当前目录：`esp32s3_cam_bench`

## 重要说明

`main/main.c` 里的摄像头 GPIO 是常见 ESP32-S3-CAM 参考值。你的 DIP-16 模块可能不同。

如果日志显示 `camera init failed`，需要按商家原理图修改这些宏：

- `CAM_PIN_XCLK`
- `CAM_PIN_SIOD`
- `CAM_PIN_SIOC`
- `CAM_PIN_D0` ~ `CAM_PIN_D7`
- `CAM_PIN_VSYNC`
- `CAM_PIN_HREF`
- `CAM_PIN_PCLK`

## 编译

当前电脑 ESP-IDF 环境缺少 Python 虚拟环境，直接命令行构建失败。

修复 ESP-IDF 后，在本目录执行：

```bat
idf.py set-target esp32s3
idf.py build
idf.py -p COMx flash monitor
```

或者用 VS Code ESP-IDF 插件打开 `esp32s3_cam_bench` 作为工程目录。

## 看结果

串口会输出类似：

```text
RESULT frame=96x96 input=96x96 cap=xxms resize=xxms fake_infer=xxms total=xxms fps=xx
RESULT frame=160x120 input=128x128 ...
RESULT frame=240x240 input=240x240 ...
```

重点看 `fps=`。

## 推荐判断

- `96x96` 能接近 5 FPS：适合分类
- `128x128` 能接近 5 FPS：较理想
- `240x240` 低于 5 FPS：不要用 240 输入做第一版
