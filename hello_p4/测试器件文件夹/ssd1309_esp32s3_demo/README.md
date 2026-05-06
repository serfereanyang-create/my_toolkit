# ESP32-S3 + SSD1309 Arduino 示例

这个示例文件适合 Arduino IDE 直接烧录，默认按 `SSD1309 128x64 SPI` 屏来写。

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

如果上电后屏幕不亮，优先检查：
1. 供电是不是 `3.3V`
2. `SDA/SCL/DC/RES/CS1` 有没有接错
3. 板子里的屏是否其实走的是 `I2C` 而不是 `SPI`
4. 驱动芯片是否真的是 `SSD1309`
