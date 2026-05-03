#include <Arduino.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <inttypes.h>

/*
 * ESP32-P4 + SC16-CO
 * Arduino IDE version
 *
 * Wiring:
 *   SC16-CO Vin -> 5V
 *   SC16-CO GND -> GND
 *   SC16-CO TXD -> GPIO32
 *   SC16-CO RXD -> GPIO33
 *   ST7735S CS   -> GPIO5
 *   ST7735S DC   -> GPIO4
 *   ST7735S RST  -> GPIO3
 *   ST7735S SDA  -> GPIO2
 *   ST7735S SCL  -> GPIO1
 *   ST7735S BLK  -> GPIO20
 */

#ifndef CO_RX_PIN_NUM
#define CO_RX_PIN_NUM 32
#endif

#ifndef CO_TX_PIN_NUM
#define CO_TX_PIN_NUM 33
#endif

#ifndef CO_BAUD
#define CO_BAUD 9600
#endif

#define TFT_CS    5
#define TFT_DC    4
#define TFT_RST   3
#define TFT_MOSI  2
#define TFT_SCLK  1
#define TFT_BLK   20

#define COLOR_BLACK   0x0000
#define COLOR_WHITE   0xFFFF
#define COLOR_RED     0xF800
#define COLOR_GREEN   0x07E0
#define COLOR_YELLOW  0xFFE0

HardwareSerial coSerial(1);
Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);

static void fillScreenAndLog(uint16_t color, const char *name) {
  Serial.print("LCD test color: ");
  Serial.println(name);
  tft.fillScreen(color);
  delay(600);
}

static void runLcdPowerOnTest() {
  Serial.println("LCD init start");
  tft.initR(INITR_BLACKTAB);
  tft.setRotation(0);
  tft.fillScreen(COLOR_BLACK);
  Serial.println("LCD init done");

  fillScreenAndLog(COLOR_RED, "RED");
  fillScreenAndLog(COLOR_GREEN, "GREEN");
  fillScreenAndLog(COLOR_WHITE, "WHITE");
  fillScreenAndLog(COLOR_BLACK, "BLACK");

  tft.setTextWrap(false);
  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, 12);
  tft.println("LCD OK");
  tft.setTextSize(1);
  tft.setCursor(8, 42);
  tft.println("Entering CO mode");
  delay(1200);
}

static uint16_t getStatusColor(uint16_t coPpm) {
  if (coPpm > 200) {
    return COLOR_RED;
  }
  if (coPpm > 50) {
    return COLOR_YELLOW;
  }
  return COLOR_GREEN;
}

static void drawWaitingScreen() {
  tft.fillScreen(COLOR_BLACK);
  tft.setTextWrap(false);
  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, 12);
  tft.println("SC16-CO");

  tft.setTextSize(1);
  tft.setCursor(8, 42);
  tft.println("Waiting data...");
  tft.setCursor(8, 58);
  tft.println("UART1 9600");
}

static void drawCoValue(uint16_t coPpm, const char *label) {
  tft.fillScreen(COLOR_BLACK);

  tft.setTextWrap(false);
  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, 10);
  tft.println("SC16-CO");

  tft.setTextSize(1);
  tft.setCursor(8, 40);
  tft.println("CO ppm");

  tft.setTextColor(getStatusColor(coPpm));
  tft.setTextSize(4);
  tft.setCursor(8, 58);
  tft.println(coPpm);

  tft.setTextSize(2);
  tft.setTextColor(COLOR_WHITE);
  tft.setCursor(8, 112);
  tft.print("Status: ");
  tft.println(label);
}

static void drawErrorScreen(uint32_t missCount) {
  tft.fillScreen(COLOR_BLACK);
  tft.setTextWrap(false);
  tft.setTextColor(COLOR_RED);
  tft.setTextSize(2);
  tft.setCursor(8, 12);
  tft.println("SC16-CO");

  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(1);
  tft.setCursor(8, 46);
  tft.println("No valid frame");
  tft.setCursor(8, 62);
  tft.print("Miss count: ");
  tft.println(missCount);
  tft.setCursor(8, 78);
  tft.println("Check wiring");
}

static uint8_t calcFrameChecksum(const uint8_t *frame, size_t len) {
  uint8_t sum = 0;
  for (size_t i = 0; i < len; ++i) {
    sum = (uint8_t)(sum + frame[i]);
  }
  return (uint8_t)(~sum);
}

static bool readCoFrame(uint16_t &coPpm) {
  uint8_t frame[9];
  unsigned long startMs = millis();

  while (millis() - startMs < 1200) {
    if (coSerial.available() > 0) {
      uint8_t firstByte = (uint8_t)coSerial.read();
      if (firstByte != 0xFF) {
        continue;
      }

      frame[0] = 0xFF;
      size_t got = coSerial.readBytes(&frame[1], 8);
      if (got != 8) {
        Serial.println("Read failed: incomplete frame");
        return false;
      }

      if (frame[1] != 0x18 || frame[2] != 0x04) {
        Serial.print("Unknown frame: ");
        for (size_t i = 0; i < sizeof(frame); ++i) {
          if (frame[i] < 0x10) {
            Serial.print('0');
          }
          Serial.print(frame[i], HEX);
          Serial.print(' ');
        }
        Serial.println();
        return false;
      }

      uint8_t checksum = calcFrameChecksum(frame, 8);
      if (checksum != frame[8]) {
        Serial.print("Checksum mismatch: calc=0x");
        Serial.print(checksum, HEX);
        Serial.print(" recv=0x");
        Serial.println(frame[8], HEX);
        return false;
      }

      coPpm = ((uint16_t)frame[4] << 8) | frame[5];
      return true;
    }

    delay(10);
  }

  Serial.println("Read failed: timeout waiting for frame header");
  return false;
}

static const char *getLabel(uint16_t coPpm) {
  if (coPpm > 200) {
    return "danger";
  }
  if (coPpm > 50) {
    return "warning";
  }
  return "normal";
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("ESP32-P4 SC16-CO Arduino test start...");
  Serial.println("Step 1: backlight on");

  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);
  delay(200);

  Serial.println("Step 2: LCD self-test");
  runLcdPowerOnTest();
  drawWaitingScreen();

  Serial.println("Step 3: SC16-CO UART begin");
  coSerial.begin(CO_BAUD, SERIAL_8N1, CO_RX_PIN_NUM, CO_TX_PIN_NUM);

  Serial.print("SC16-CO UART ready. RX=");
  Serial.print(CO_RX_PIN_NUM);
  Serial.print(" TX=");
  Serial.print(CO_TX_PIN_NUM);
  Serial.print(" Baud=");
  Serial.println(CO_BAUD);
  Serial.println("Step 4: waiting SC16-CO data");
}

void loop() {
  static uint32_t missCount = 0;
  static bool showingError = false;
  uint16_t coPpm = 0;

  if (readCoFrame(coPpm)) {
    const char *label = getLabel(coPpm);
    missCount = 0;
    showingError = false;
    Serial.print("CO = ");
    Serial.print(coPpm);
    Serial.print(" ppm    status = ");
    Serial.println(label);
    drawCoValue(coPpm, label);
  } else {
    missCount++;
    if (missCount >= 3) {
      Serial.print("Missed valid frames: ");
      Serial.println(missCount);
      if (!showingError) {
        drawErrorScreen(missCount);
        showingError = true;
      }
    }
  }

  delay(200);
}
