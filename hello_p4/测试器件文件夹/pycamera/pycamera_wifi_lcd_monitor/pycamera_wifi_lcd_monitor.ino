#include <Arduino.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>

/*
 * ESP32-P4 + Yahboom ESP32-Lite WiFi camera monitor
 *
 * This sketch follows the official Yahboom WiFi camera route:
 * UART is used for configuration / query commands only.
 * Image transport is expected to happen over WiFi, not over UART.
 */

static const int CAM_RX_PIN = 47;
static const int CAM_TX_PIN = 46;
static const uint32_t CAM_UART_BAUD = 115200;

// 0 = AP, 1 = STA, 2 = AP+STA
static const int WIFI_MODE = 2;
static const char *STA_SSID = "wifi5";
static const char *STA_PASSWORD = "12345678";

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

HardwareSerial camSerial(1);
Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);

String rxLine;
String fwVersion = "--";
String staIp = "--";
String apIp = "--";
String lastResponse = "Waiting";
String stateText = "Boot";
unsigned long lastUiMs = 0;

enum StepState {
  STEP_BOOT,
  STEP_QUERY_VERSION,
  STEP_SET_MODE,
  STEP_SET_STA_SSID,
  STEP_SET_STA_PASSWORD,
  STEP_QUERY_STA_IP,
  STEP_QUERY_AP_IP,
  STEP_IDLE
};

StepState stepState = STEP_BOOT;
unsigned long stepStartedMs = 0;

static void sendCamCommand(const String &cmd, unsigned long waitMs) {
  Serial.print("CMD -> ");
  Serial.println(cmd);
  camSerial.print(cmd);
  stepStartedMs = millis() + waitMs;
}

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

static const char *modeLabel(int mode) {
  if (mode == 0) return "AP";
  if (mode == 1) return "STA";
  if (mode == 2) return "AP+STA";
  return "UNK";
}

static void drawMainScreen() {
  tft.fillScreen(COLOR_BLACK);
  tft.setTextWrap(false);

  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(2);
  tft.setCursor(6, 6);
  tft.println("ESP32-Lite");

  tft.setTextSize(1);
  tft.setTextColor(COLOR_CYAN);
  tft.setCursor(6, 28);
  tft.print("Mode: ");
  tft.println(modeLabel(WIFI_MODE));

  tft.setTextColor(COLOR_WHITE);
  tft.setCursor(6, 42);
  tft.print("FW: ");
  tft.println(fwVersion);

  tft.setCursor(6, 58);
  tft.print("STA:");
  tft.println(staIp);

  tft.setCursor(6, 74);
  tft.print("AP :");
  tft.println(apIp);

  tft.setCursor(6, 92);
  tft.setTextColor(COLOR_YELLOW);
  tft.print("State:");
  tft.println(stateText);

  tft.setTextColor(COLOR_WHITE);
  tft.setCursor(6, 108);
  tft.println("UART cfg only");

  tft.setCursor(6, 122);
  tft.setTextColor(COLOR_GREEN);
  tft.println(lastResponse);
}

static void refreshUi(bool force = false) {
  if (!force && millis() - lastUiMs < 200) {
    return;
  }
  lastUiMs = millis();
  drawMainScreen();
}

static void handleResponseLine(const String &line) {
  if (line.length() == 0) {
    return;
  }

  Serial.print("RX <- ");
  Serial.println(line);
  lastResponse = line;

  if (line.indexOf("YAHBOOM VerSion") >= 0 || line.indexOf("Version") >= 0) {
    fwVersion = line;
  } else if (line.indexOf('.') >= 0 && line.indexOf("192.") >= 0) {
    if (stepState == STEP_QUERY_STA_IP) {
      staIp = line;
    } else if (stepState == STEP_QUERY_AP_IP) {
      apIp = line;
    }
  } else if (line.indexOf("ok") >= 0 || line.indexOf("OK") >= 0) {
    // keep lastResponse only
  }

  refreshUi(true);
}

static void pollCamSerial() {
  while (camSerial.available() > 0) {
    char c = (char)camSerial.read();
    if (c == '\r') {
      continue;
    }
    if (c == '\n') {
      if (rxLine.length() > 0) {
        handleResponseLine(rxLine);
        rxLine = "";
      }
      continue;
    }

    if (rxLine.length() < 96) {
      rxLine += c;
    }
  }
}

static void runStepMachine() {
  if (millis() < stepStartedMs) {
    return;
  }

  switch (stepState) {
    case STEP_BOOT:
      stateText = "Query ver";
      sendCamCommand("wifi_ver", 600);
      stepState = STEP_QUERY_VERSION;
      break;

    case STEP_QUERY_VERSION:
      stateText = "Set mode";
      sendCamCommand(String("wifi_mode:") + WIFI_MODE, 1200);
      stepState = STEP_SET_MODE;
      break;

    case STEP_SET_MODE:
      stateText = "Set ssid";
      sendCamCommand(String("sta_ssid:") + STA_SSID, 1200);
      stepState = STEP_SET_STA_SSID;
      break;

    case STEP_SET_STA_SSID:
      stateText = "Set pwd";
      sendCamCommand(String("sta_pd:") + STA_PASSWORD, 3500);
      stepState = STEP_SET_STA_PASSWORD;
      break;

    case STEP_SET_STA_PASSWORD:
      stateText = "Ask STA IP";
      sendCamCommand("sta_ip", 1200);
      stepState = STEP_QUERY_STA_IP;
      break;

    case STEP_QUERY_STA_IP:
      stateText = "Ask AP IP";
      sendCamCommand("ap_ip", 1200);
      stepState = STEP_QUERY_AP_IP;
      break;

    case STEP_QUERY_AP_IP:
      stateText = "WiFi ready";
      stepState = STEP_IDLE;
      stepStartedMs = millis() + 5000;
      break;

    case STEP_IDLE:
      stateText = "Refresh IP";
      sendCamCommand("sta_ip", 1200);
      stepState = STEP_QUERY_STA_IP;
      break;
  }

  refreshUi(true);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("ESP32-Lite WiFi monitor start...");

  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);
  runLcdSelfTest();

  camSerial.begin(CAM_UART_BAUD, SERIAL_8N1, CAM_RX_PIN, CAM_TX_PIN);

  stateText = "Boot";
  lastResponse = "Power on cam";
  stepStartedMs = millis() + 1500;
  refreshUi(true);
}

void loop() {
  pollCamSerial();
  runStepMachine();
  refreshUi();
}
