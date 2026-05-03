#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <Adafruit_SGP30.h>

// ESP32-P4 + SGP30 + ST7735S LCD realtime display

static const int I2C_SDA_PIN = 47;
static const int I2C_SCL_PIN = 46;
static const uint32_t SAMPLE_INTERVAL_MS = 1000;

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

Adafruit_SGP30 sgp;
Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);

uint32_t sampleIndex = 0;
uint32_t lastSampleMs = 0;

static void fillScreenAndLog(uint16_t color, const char *name) {
  Serial.print("LCD test color: ");
  Serial.println(name);
  tft.fillScreen(color);
  delay(500);
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
  tft.setCursor(12, 16);
  tft.println("LCD OK");
  tft.setTextSize(1);
  tft.setCursor(12, 48);
  tft.println("Entering SGP30");
  delay(1000);
}

static uint16_t getTvocColor(uint16_t tvoc) {
  if (tvoc > 220) {
    return COLOR_RED;
  }
  if (tvoc > 80) {
    return COLOR_YELLOW;
  }
  return COLOR_GREEN;
}

static const char *getTvocLabel(uint16_t tvoc) {
  if (tvoc > 220) {
    return "HIGH";
  }
  if (tvoc > 80) {
    return "MID";
  }
  return "GOOD";
}

static void drawWaitingScreen() {
  tft.fillScreen(COLOR_BLACK);
  tft.setTextWrap(false);
  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, 10);
  tft.println("SGP30");

  tft.setTextSize(1);
  tft.setCursor(8, 40);
  tft.println("Waiting data...");
  tft.setCursor(8, 56);
  tft.print("I2C SDA=");
  tft.println(I2C_SDA_PIN);
  tft.setCursor(8, 72);
  tft.print("I2C SCL=");
  tft.println(I2C_SCL_PIN);
}

static void drawSensorValues(uint16_t tvoc, uint32_t index) {
  tft.fillScreen(COLOR_BLACK);
  tft.setTextWrap(false);

  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, 6);
  tft.println("SGP30");

  tft.setTextSize(1);
  tft.setCursor(8, 30);
  tft.setTextColor(COLOR_CYAN);
  tft.print("Sample ");
  tft.println(index);

  tft.setTextColor(COLOR_WHITE);
  tft.setCursor(8, 48);
  tft.println("TVOC ppb");

  tft.setTextColor(getTvocColor(tvoc));
  tft.setTextSize(3);
  tft.setCursor(8, 62);
  tft.println(tvoc);

  tft.setTextSize(1);
  tft.setTextColor(COLOR_WHITE);
  tft.setCursor(8, 102);
  tft.print("VOC level: ");
  tft.println(getTvocLabel(tvoc));

  tft.setCursor(8, 114);
  tft.println("TVOC focus only");
}

static void drawErrorScreen(const char *message) {
  tft.fillScreen(COLOR_BLACK);
  tft.setTextWrap(false);
  tft.setTextColor(COLOR_RED);
  tft.setTextSize(2);
  tft.setCursor(8, 10);
  tft.println("SGP30");

  tft.setTextSize(1);
  tft.setCursor(8, 44);
  tft.setTextColor(COLOR_WHITE);
  tft.println("Sensor error");
  tft.setCursor(8, 62);
  tft.println(message);
}

static void printSensorRow(uint32_t index, uint16_t tvoc) {
  Serial.print(index);
  Serial.print(',');
  Serial.println(tvoc);
}

void setup() {
  Serial.begin(115200);
  delay(1200);
  Serial.println();
  Serial.println("ESP32-P4 SGP30 LCD realtime start...");

  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);
  delay(200);

  runLcdPowerOnTest();
  drawWaitingScreen();

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  Serial.print("I2C SDA=");
  Serial.print(I2C_SDA_PIN);
  Serial.print(" SCL=");
  Serial.println(I2C_SCL_PIN);

  if (!sgp.begin()) {
    Serial.println("# ERROR: SGP30 not found. Check wiring and I2C pins.");
    drawErrorScreen("Not found");
    while (true) {
      delay(1000);
    }
  }

  Serial.print("# Found SGP30 serial: ");
  Serial.print(sgp.serialnumber[0], HEX);
  Serial.print('-');
  Serial.print(sgp.serialnumber[1], HEX);
  Serial.print('-');
  Serial.println(sgp.serialnumber[2], HEX);

  Serial.println("index,tvoc_ppb");
  lastSampleMs = millis();
}

void loop() {
  if (millis() - lastSampleMs < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSampleMs = millis();

  if (!sgp.IAQmeasure()) {
    Serial.println("# ERROR: IAQmeasure failed");
    drawErrorScreen("IAQ failed");
    return;
  }

  sampleIndex++;
  printSensorRow(sampleIndex, sgp.TVOC);
  drawSensorValues(sgp.TVOC, sampleIndex);
}
