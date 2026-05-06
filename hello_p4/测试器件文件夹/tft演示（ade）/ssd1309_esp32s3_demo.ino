#include <Arduino.h>
#include <SPI.h>
#include <U8g2lib.h>

/*
  ESP32-S3 + SSD1309 128x64 SPI demo

  Wiring labels from your screen:
  - CS1  -> display chip select
  - DC   -> data/command
  - SDA  -> MOSI
  - SCL  -> SCLK
  - RES  -> reset
  - VCC  -> 3.3V
  - GND  -> GND

  Notes:
  - FSO is usually SPI MISO. OLED display normally does not need it.
  - CS2 is usually for TF card / second SPI device. This demo does not use it.
*/

// Wiring you provided:
// CS2/FSO/CS1/DC/SDA/SCL/RES/VCC/GND/5VIN = 4/5/6/7/8/9/10/3V3/GND/5VIN
static const int PIN_OLED_CS = 6;
static const int PIN_OLED_DC = 7;
static const int PIN_OLED_RST = 10;
static const int PIN_OLED_MOSI = 8;
static const int PIN_OLED_SCK = 9;

// Optional pins from your module, unused in this demo.
static const int PIN_OLED_FSO = 5;
static const int PIN_OLED_CS2 = 4;

U8G2_SSD1309_128X64_NONAME0_F_4W_HW_SPI display(
  U8G2_R0,
  PIN_OLED_CS,
  PIN_OLED_DC,
  PIN_OLED_RST
);

unsigned long lastTick = 0;
int patternIndex = 0;

void drawPattern(int index) {
  display.clearBuffer();

  switch (index % 4) {
    case 0:
      for (int x = 0; x < 128; x += 8) {
        display.drawBox(x, 0, 4, 64);
      }
      break;

    case 1:
      for (int y = 0; y < 64; y += 8) {
        display.drawBox(0, y, 128, 4);
      }
      break;

    case 2:
      for (int y = 0; y < 64; y += 16) {
        for (int x = 0; x < 128; x += 16) {
          if (((x + y) / 16) % 2 == 0) {
            display.drawBox(x, y, 16, 16);
          }
        }
      }
      break;

    default:
      display.drawBox(0, 0, 128, 64);
      display.setDrawColor(0);
      display.setFont(u8g2_font_6x12_tf);
      display.drawStr(18, 30, "SSD1309 TEST");
      display.drawStr(28, 46, "PATTERN 4");
      display.setDrawColor(1);
      break;
  }

  display.sendBuffer();
}

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println();
  Serial.println("SSD1309 pattern test start");
  Serial.println("If screen stays dark, check GPIO mapping first.");

  SPI.begin(PIN_OLED_SCK, PIN_OLED_FSO, PIN_OLED_MOSI, PIN_OLED_CS);
  display.begin();
  display.setContrast(255);
  drawPattern(patternIndex);
}

void loop() {
  if (millis() - lastTick >= 1000) {
    lastTick = millis();
    patternIndex++;
    drawPattern(patternIndex);
    Serial.printf("Pattern: %d\n", (patternIndex % 4) + 1);
  }
}
