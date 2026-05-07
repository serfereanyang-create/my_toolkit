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

// Change these GPIO numbers to match your ESP32-S3 wiring.
static const int PIN_OLED_CS = 10;
static const int PIN_OLED_DC = 11;
static const int PIN_OLED_RST = 12;
static const int PIN_OLED_MOSI = 13;
static const int PIN_OLED_SCK = 14;

// Optional pins from your module, unused in this demo.
static const int PIN_OLED_FSO = -1;
static const int PIN_OLED_CS2 = -1;

U8G2_SSD1309_128X64_NONAME0_F_4W_HW_SPI display(
  U8G2_R0,
  PIN_OLED_CS,
  PIN_OLED_DC,
  PIN_OLED_RST
);

unsigned long lastTick = 0;
int counter = 0;

void drawScreen() {
  char line[32];

  display.clearBuffer();

  display.setFont(u8g2_font_6x12_tf);
  display.drawStr(0, 12, "ESP32-S3 + SSD1309");
  display.drawStr(0, 26, "128x64 SPI Demo");

  snprintf(line, sizeof(line), "Count: %d", counter);
  display.drawStr(0, 40, line);

  snprintf(line, sizeof(line), "Uptime: %lus", millis() / 1000UL);
  display.drawStr(0, 54, line);

  display.drawFrame(96, 18, 28, 28);
  display.drawBox(100, 22, (counter % 5) * 4 + 4, 20);

  display.sendBuffer();
}

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println();
  Serial.println("SSD1309 demo start");
  Serial.println("If screen stays dark, check GPIO mapping first.");

  SPI.begin(PIN_OLED_SCK, PIN_OLED_FSO, PIN_OLED_MOSI, PIN_OLED_CS);
  display.begin();
  display.setContrast(255);
  drawScreen();
}

void loop() {
  if (millis() - lastTick >= 1000) {
    lastTick = millis();
    counter++;
    drawScreen();
    Serial.printf("Screen refresh: %d\n", counter);
  }
}
