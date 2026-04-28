/*
 * ESP32P4 + ST7735S 128x160 RGB TFT 颜色测试
 * 开发板: JC-ESP32P4-M3-DEV
 * 接线: 软SPI，引脚可自由定义
 */

#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>

// ================== 引脚定义 ==================
#define TFT_CS     5   // CS
#define TFT_DC     4   // DC
#define TFT_RST    3   // RST
#define TFT_MOSI   2   // SDA (MOSI)
#define TFT_SCLK   1   // SCL (SCK)
#define TFT_BLK   20   // 背光控制

// 使用软SPI构造函数: CS, DC, MOSI, SCLK, RST
Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);

// 常用颜色定义（RGB565格式）
#define COLOR_BLACK   0x0000
#define COLOR_WHITE   0xFFFF
#define COLOR_RED     0xF800
#define COLOR_GREEN   0x07E0
#define COLOR_BLUE    0x001F
#define COLOR_YELLOW  0xFFE0
#define COLOR_CYAN    0x07FF
#define COLOR_MAGENTA 0xF81F
#define COLOR_ORANGE  0xFC00

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32P4 ST7735S 颜色测试启动...");

  // 初始化背光（高电平点亮，也可接PWM调光）
  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);

  // 初始化屏幕
  // 128x160 屏幕通常用 INITR_BLACKTAB，如果颜色偏移可换成 INITR_GREENTAB
  tft.initR(INITR_BLACKTAB);
  
  // 设置方向: 0=竖屏, 1=横屏, 2=竖屏翻转, 3=横屏翻转
  tft.setRotation(0);
  
  // 清屏
  tft.fillScreen(COLOR_BLACK);

  Serial.println("屏幕初始化完成，开始颜色测试...");
  delay(500);

  // ====== 第一步：全屏纯色循环测试 ======
  testFullScreenColors();

  // ====== 第二步：8色块并排测试（检查坏点/偏色） ======
  testColorBars();

  // ====== 第三步：文字与反色测试 ======
  testTextAndInvert();

  Serial.println("所有测试完成，进入循环...");
}

void loop() {
  // 循环做渐变呼吸灯背光效果（可选）
  for (int duty = 0; duty <= 255; duty += 5) {
    analogWrite(TFT_BLK, duty);  // 如果BLK引脚支持PWM
    delay(20);
  }
  for (int duty = 255; duty >= 0; duty -= 5) {
    analogWrite(TFT_BLK, duty);
    delay(20);
  }
}

// ================== 测试函数 ==================

// 1. 全屏纯色切换（最基础的坏点/颜色检查）
void testFullScreenColors() {
  uint16_t colors[] = {COLOR_RED, COLOR_GREEN, COLOR_BLUE, COLOR_WHITE, COLOR_BLACK, COLOR_YELLOW, COLOR_CYAN, COLOR_MAGENTA};
  const char* names[] = {"RED", "GREEN", "BLUE", "WHITE", "BLACK", "YELLOW", "CYAN", "MAGENTA"};
  
  for (int i = 0; i < 8; i++) {
    tft.fillScreen(colors[i]);
    tft.setCursor(10, 10);
    tft.setTextColor(COLOR_BLACK);
    if (colors[i] == COLOR_BLACK) tft.setTextColor(COLOR_WHITE);
    tft.setTextSize(2);
    tft.println(names[i]);
    
    Serial.print("当前显示: ");
    Serial.println(names[i]);
    delay(1500);
  }
}

// 2. 8色条测试（同时显示，检查均匀性）
void testColorBars() {
  tft.fillScreen(COLOR_BLACK);
  int barWidth = tft.width() / 4;   // 128/4 = 32
  int barHeight = tft.height() / 2; // 160/2 = 80
  
  uint16_t topColors[4] = {COLOR_RED, COLOR_GREEN, COLOR_BLUE, COLOR_WHITE};
  uint16_t botColors[4] = {COLOR_YELLOW, COLOR_CYAN, COLOR_MAGENTA, COLOR_ORANGE};
  
  for (int i = 0; i < 4; i++) {
    tft.fillRect(i * barWidth, 0, barWidth, barHeight, topColors[i]);
    tft.fillRect(i * barWidth, barHeight, barWidth, barHeight, botColors[i]);
  }
  
  // 画分割线
  tft.drawFastHLine(0, barHeight, tft.width(), COLOR_BLACK);
  for (int i = 1; i < 4; i++) {
    tft.drawFastVLine(i * barWidth, 0, tft.height(), COLOR_BLACK);
  }
  
  delay(3000);
}

// 3. 文字清晰度与反色测试
void testTextAndInvert() {
  tft.fillScreen(COLOR_BLACK);
  
  tft.setTextSize(1);
  tft.setTextColor(COLOR_WHITE);
  tft.setCursor(0, 0);
  tft.println("ESP32P4 ST7735S Test");
  tft.println("128x160 RGB TFT");
  tft.println("------------------");
  
  tft.setTextSize(2);
  tft.setTextColor(COLOR_GREEN);
  tft.println("PASS");
  
  tft.setTextSize(1);
  tft.setTextColor(COLOR_YELLOW);
  tft.setCursor(0, 80);
  tft.println("RGB Color Check:");
  
  // 画三个小色块 R G B
  tft.fillRect(10, 100, 30, 20, COLOR_RED);
  tft.fillRect(50, 100, 30, 20, COLOR_GREEN);
  tft.fillRect(90, 100, 30, 20, COLOR_BLUE);
  
  delay(3000);
}