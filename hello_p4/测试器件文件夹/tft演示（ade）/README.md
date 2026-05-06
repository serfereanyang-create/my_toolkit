# ESP32-S3 + SSD1309 Arduino 示例

这个示例文件适合 Arduino IDE 直接烧录，默认按 `SSD1309 128x64 SPI` 屏来写。

屏幕参数：
- 驱动芯片：`SSD1309`
- 分辨率：`128 x 64`
- 接口类型：`4线 SPI`
- 显示类型：`单色 OLED`
- 供电：`3.3V`

需要安装库：
- `U8g2`

接线先按这组逻辑对应：
- `CS1` -> OLED 的 `CS`
- `DC` -> OLED 的 `DC`
- `SDA` -> OLED 的 `MOSI`
- `SCL` -> OLED 的 `SCK`
- `RES` -> OLED 的 `RST`
- `VCC` -> `3.3V`
- `GND` -> `GND`

你这次提供的实际接线为：
- `CS2 = GPIO4`
- `FSO = GPIO5`
- `CS1 = GPIO6`
- `DC = GPIO7`
- `SDA = GPIO8`
- `SCL = GPIO9`
- `RES = GPIO10`
- `VCC = 3V3`
- `GND = GND`
- `5VIN = 5VIN`

你这块屏上的另外两个脚通常这样理解：
- `FSO` 通常是 `MISO`，OLED 显示一般不用
- `CS2` 通常给第二个 SPI 设备用，很多这种板子是留给 TF 卡

烧录前只需要改 `ssd1309_esp32s3_demo.ino` 顶部这些引脚：

```cpp
static const int PIN_OLED_CS = 10;
static const int PIN_OLED_DC = 11;
static const int PIN_OLED_RST = 12;
static const int PIN_OLED_MOSI = 13;
static const int PIN_OLED_SCK = 14;
```

桌面这个工程当前已改成：

```cpp
static const int PIN_OLED_CS = 6;
static const int PIN_OLED_DC = 7;
static const int PIN_OLED_RST = 10;
static const int PIN_OLED_MOSI = 8;
static const int PIN_OLED_SCK = 9;
```

如果上电后屏幕不亮，优先检查：
1. 供电是不是 `3.3V`
2. `SDA/SCL/DC/RES/CS1` 有没有接错
3. 板子里的屏是否其实走的是 `I2C` 而不是 `SPI`
4. 驱动芯片是否真的是 `SSD1309`
