# SC16_CO 说明

这个目录放的是 `SC16-CO` 一氧化碳传感器相关的两个版本：

- `main.c`
  - 偏 ESP-IDF/C 工程用法
  - 只负责读取 `SC16-CO` 的串口数据并打印 `CO ppm`
- `sc16_co_fan_control_example/sc16_co_fan_control_example.ino`
  - 偏 Arduino 复现用法
  - 在读取 `SC16-CO` 浓度的基础上，联动 2 线风扇 PWM 调速

## 目录结构

- `main.c`
- `sc16_co_fan_control_example/sc16_co_fan_control_example.ino`
- `CMakelists.txt`

## 接线

### SC16-CO

当前代码默认接线：

- `Vin -> 5V`
- `GND -> GND`
- `TXD -> GPIO32`（ESP32-P4 接收）
- `RXD -> GPIO33`（ESP32-P4 发送）

代码里的默认宏：

```c
#define CO_RX_PIN_NUM 32
#define CO_TX_PIN_NUM 33
```

### 2 线风扇

Arduino 示例里默认风扇控制脚：

```c
#define FAN_PWM_PIN_NUM 4
```

注意：

- 这是控制信号脚，不代表可以直接让 ESP32 引脚给风扇供电
- 2 线风扇通常需要外部供电，并通过 MOSFET/驱动模块做 PWM 控制
- 如果是你当前硬件环境下 `pwm.ino` 这套接法已经验证可用，就保持和那边一致

## `main.c` 在做什么

`main.c` 是最基础的读数版本，逻辑很简单：

1. 初始化 `UART1`
2. 等待 `SC16-CO` 发回 9 字节数据帧
3. 校验帧头和 checksum
4. 取出 `ppm`
5. 根据数值打印：
   - `normal`
   - `warning`
   - `danger`

这个版本适合先确认：

- 传感器接线对不对
- 串口有没有数据
- `ppm` 能不能稳定读到

## Arduino 联动示例在做什么

`sc16_co_fan_control_example.ino` 是在 `SC16-CO` 读数基础上，加入风扇联动逻辑的版本。

它参考了 `pwm调频风扇/pwm.ino` 的 PWM 调用方式：

```cpp
ledcAttachChannel(...)
ledcWriteChannel(...)
```

也就是说，风扇控制这部分是按已经验证能跑的那套风格写的，不再用另一套 IDF 配置结构。

## 当前浓度 -> 风速策略

Arduino 示例里当前分档如下：

- `0~30 ppm -> 30%`
- `31~50 ppm -> 35%`
- `51~100 ppm -> 50%`
- `101~150 ppm -> 70%`
- `151~200 ppm -> 85%`
- `>200 ppm -> 100%`

这样做的目的：

- 风扇始终保持最低转速
- `CO` 升高时再逐步加速

另外还保留了一个启动保护逻辑：

- 如果风扇当前近似停转
- 且目标风速不是满速
- 会先 `100%` 冲一下，再降到目标速度

这样更适合 2 线风扇低速起转不稳的情况。

## 复现建议

建议按这个顺序复现：

1. 先跑 `main.c`
2. 确认串口能稳定读到 `CO ppm`
3. 单独确认风扇 PWM 方案能转
4. 再跑 `sc16_co_fan_control_example.ino`

这样排错最清楚：

- 如果 `main.c` 不出数据，是传感器/UART 问题
- 如果 `pwm.ino` 不转，是风扇/PWM/接线问题
- 两边都单独没问题，再测联动逻辑

## 常改的地方

最常需要调的就是这几个参数：

### 1. SC16-CO 串口引脚

```c
CO_RX_PIN_NUM
CO_TX_PIN_NUM
```

### 2. 风扇 PWM 引脚

```c
FAN_PWM_PIN_NUM
```

### 3. PWM 频率

```c
FAN_PWM_FREQ_HZ
```

### 4. 浓度分档

在 `CO_FAN_RULES` 里改。

## 给后来人的一句话

如果你只是想确认 `SC16-CO` 能不能读，先看 `main.c`。  
如果你是想做“CO 浓度升高 -> 风扇加速”，直接看 `sc16_co_fan_control_example.ino`。
