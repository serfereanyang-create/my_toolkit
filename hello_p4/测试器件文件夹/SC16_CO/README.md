# SC16_CO 复现说明

这个目录里放的是 `SC16-CO` 一氧化碳传感器相关示例，目标是让后面的人拿到目录后，能快速知道：

- 哪个文件适合 Arduino IDE
- 哪个文件是原始 IDF 版
- 怎么接线
- 烧录后看到什么现象算正常

## 目录说明

### 1. `main.c`

路径：

`D:\codex\my_toolkit\hello_p4\测试器件文件夹\SC16_CO\main.c`

用途：

- 原始 ESP-IDF 风格版本
- 入口是 `app_main()`
- 只负责读取 `SC16-CO` 串口数据并打印 `CO ppm`

适合：

- 你在 ESP-IDF 工程里验证传感器是否能正常读数

### 2. `sc16_co_p4_arduino\sc16_co_p4_arduino.ino`

路径：

`D:\codex\my_toolkit\hello_p4\测试器件文件夹\SC16_CO\sc16_co_p4_arduino\sc16_co_p4_arduino.ino`

用途：

- 给 `ESP32-P4` 在 `Arduino IDE` 里直接编译
- 参考了 `main.c` 的 SC16-CO 解析逻辑
- 参考了 `lcd\rgb_test.ino` 的 LCD 初始化和显示方式

功能：

- 串口实时打印 CO 数值
- ST7735S LCD 实时显示 CO 数值和状态
- 开机先做 LCD 自检，方便判断白屏问题是不是屏幕初始化导致

适合：

- ESP32-P4
- Arduino IDE
- 需要边看串口边看屏幕实时数值

### 3. `sc16_co_fan_control_example\sc16_co_fan_control_example.ino`

路径：

`D:\codex\my_toolkit\hello_p4\测试器件文件夹\SC16_CO\sc16_co_fan_control_example\sc16_co_fan_control_example.ino`

用途：

- SC16-CO 浓度联动 2 线风扇

特点：

- 风扇始终保留最低转速
- CO 升高时再逐步加速

## 复现建议

如果只是要先确认：

- 屏幕有没有正常显示
- SC16-CO 能不能读到数

优先烧录这个文件：

`D:\codex\my_toolkit\hello_p4\测试器件文件夹\SC16_CO\sc16_co_p4_arduino\sc16_co_p4_arduino.ino`

因为这份最适合现在这个组合：

- ESP32-P4
- Arduino IDE
- ST7735S LCD
- SC16-CO

## 接线

### SC16-CO -> ESP32-P4

- `Vin -> 5V`
- `GND -> GND`
- `TXD -> GPIO32`
- `RXD -> GPIO33`

### ST7735S LCD -> ESP32-P4

- `CS -> GPIO5`
- `DC -> GPIO4`
- `RST -> GPIO3`
- `SDA(MOSI) -> GPIO2`
- `SCL(SCK) -> GPIO1`
- `BLK -> GPIO20`

## Arduino 版运行现象

### 正常启动时

烧录 `sc16_co_p4_arduino.ino` 后，屏幕会先执行 LCD 自检：

1. 全屏红色
2. 全屏绿色
3. 全屏白色
4. 全屏黑色
5. 显示 `LCD OK`
6. 然后进入 CO 数据显示页面

如果看到这一步，基本说明：

- 屏幕接线是通的
- LCD 初始化参数当前可用

### 串口输出

串口监视器波特率用：

`115200`

启动时会看到类似输出：

```text
Step 1: backlight on
Step 2: LCD self-test
LCD init start
LCD init done
Step 3: SC16-CO UART begin
Step 4: waiting SC16-CO data
```

读到有效数据后会继续打印：

```text
CO = 12 ppm    status = normal
```

### 屏幕显示规则

- `<= 50 ppm`：绿色
- `51 ~ 200 ppm`：黄色
- `> 200 ppm`：红色

屏幕会显示：

- 当前 `CO ppm` 数值
- 当前状态 `normal / warning / danger`

如果连续读不到有效帧，屏幕会显示错误提示。

## 白屏时怎么排

如果出现“背光亮，但白屏无内容”，优先看这几个点：

1. 先确认烧录的是不是 `sc16_co_p4_arduino.ino`
2. 串口监视器波特率是不是 `115200`
3. LCD 接线是不是和上面一致
4. 屏幕型号是不是这套 `ST7735S`
5. 先看 LCD 自检颜色页能不能出来

如果自检颜色页能出来，而后面没有 CO 数值，那问题通常不在 LCD，而在 `SC16-CO` 串口数据。

## 为什么这里给的是 `.ino` 不是纯 `.c`

虽然需求一开始提的是“适合 P4 在 Arduino IDE 编译的 C 语言文件”，但 Arduino IDE 实际上走的是 Arduino 草图 / C++ 方式。

所以为了后面的人最容易复现，这里保留了两条线：

- `main.c`：给 IDF 工程参考
- `sc16_co_p4_arduino.ino`：给 Arduino IDE 直接编译

这样最省事，也最贴近实际使用。
