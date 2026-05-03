#include <Arduino.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>

/*
 * ESP32-P4 LCD progress monitor for PC-side image capture
 *
 * Expected UART line from PC:
 *   SAVE,<current>,<total>,<status>
 *
 * Example:
 *   SAVE,12,50,OK
 *   SAVE,50,50,DONE
 */

static const int PC_RX_PIN = 47;
static const int PC_TX_PIN = 46;
static const uint32_t PC_UART_BAUD = 115200;

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
#define COLOR_CYAN    0x07FF

HardwareSerial pcSerial(1);
Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);

String rxLine;
uint32_t currentCount = 0;
uint32_t totalCount = 50;
String statusText = "Waiting";

static void lcdFillTest(uint16_t color) {
  tft.fillScreen(color);
  delay(250);
}

static void runLcdSelfTest() {
  tft.initR(INITR_BLACKTAB);
  tft.setRotation(0);
  lcdFillTest(COLOR_RED);
  lcdFillTest(COLOR_GREEN);
  lcdFillTest(COLOR_WHITE);
  lcdFillTest(COLOR_BLACK);
}

static void drawProgressBar(int x, int y, int w, int h, int percent) {
  percent = constrain(percent, 0, 100);
  tft.drawRect(x, y, w, h, COLOR_WHITE);
  int fillWidth = (w - 2) * percent / 100;
  tft.fillRect(x + 1, y + 1, w - 2, h - 2, COLOR_BLACK);
  if (fillWidth > 0) {
    uint16_t color = COLOR_GREEN;
    if (statusText == "FAIL") {
      color = COLOR_RED;
    } else if (statusText == "STOP") {
      color = COLOR_YELLOW;
    }
    tft.fillRect(x + 1, y + 1, fillWidth, h - 2, color);
  }
}

static void drawMainScreen() {
  int percent = 0;
  if (totalCount > 0) {
    percent = (int)((currentCount * 100UL) / totalCount);
  }

  tft.fillScreen(COLOR_BLACK);
  tft.setTextWrap(false);

  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, 8);
  tft.println("PC Capture");

  tft.setTextSize(1);
  tft.setTextColor(COLOR_CYAN);
  tft.setCursor(8, 34);
  tft.println("Saved images");

  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(3);
  tft.setCursor(8, 50);
  tft.print(currentCount);
  tft.print("/");
  tft.println(totalCount);

  tft.setTextSize(1);
  tft.setCursor(8, 92);
  tft.print("Status: ");
  tft.println(statusText);

  tft.setCursor(8, 108);
  tft.print("Progress: ");
  tft.print(percent);
  tft.println("%");

  drawProgressBar(8, 124, 112, 4, percent);
}

static bool parseSaveLine(const String &line, uint32_t &current, uint32_t &total, String &status) {
  if (!line.startsWith("SAVE,")) {
    return false;
  }

  int comma1 = line.indexOf(',');
  int comma2 = line.indexOf(',', comma1 + 1);
  int comma3 = line.indexOf(',', comma2 + 1);
  if (comma1 < 0 || comma2 < 0 || comma3 < 0) {
    return false;
  }

  current = (uint32_t)line.substring(comma1 + 1, comma2).toInt();
  total = (uint32_t)line.substring(comma2 + 1, comma3).toInt();
  status = line.substring(comma3 + 1);
  return total > 0;
}

static void pollPcSerial() {
  while (pcSerial.available() > 0) {
    char c = (char)pcSerial.read();
    if (c == '\r') {
      continue;
    }
    if (c == '\n') {
      if (rxLine.length() > 0) {
        uint32_t current = 0;
        uint32_t total = 0;
        String status;
        if (parseSaveLine(rxLine, current, total, status)) {
          currentCount = current;
          totalCount = total;
          statusText = status;
          drawMainScreen();
        }
        rxLine = "";
      }
      continue;
    }

    if (rxLine.length() < 64) {
      rxLine += c;
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);
  runLcdSelfTest();

  pcSerial.begin(PC_UART_BAUD, SERIAL_8N1, PC_RX_PIN, PC_TX_PIN);
  drawMainScreen();
}

void loop() {
  pollPcSerial();
}
