#include <Arduino.h>
#include <U8g2lib.h>

static const int FAN_PWM_PIN = 17;
static const int PWM_CHANNEL = 0;
static const int PWM_FREQ = 25000;
static const int PWM_RESOLUTION = 8;
static const int PWM_MAX_DUTY = (1 << PWM_RESOLUTION) - 1;

// OLED wiring kept the same as your existing screen setup.
static const int PIN_OLED_CS = 6;
static const int PIN_OLED_DC = 7;
static const int PIN_OLED_RST = 10;
static const int PIN_OLED_MOSI = 8;
static const int PIN_OLED_SCK = 9;

U8G2_SSD1309_128X64_NONAME0_F_4W_SW_SPI display(
  U8G2_R0,
  PIN_OLED_SCK,
  PIN_OLED_MOSI,
  PIN_OLED_CS,
  PIN_OLED_DC,
  PIN_OLED_RST
);

int currentPercent = 0;
int currentDuty = 0;

void drawStatus() {
  char line[32];
  int barWidth = map(currentPercent, 0, 100, 0, 108);

  display.clearBuffer();
  display.setFont(u8g2_font_6x12_tf);

  display.drawStr(0, 12, "ESP32-S3 FAN PWM");

  snprintf(line, sizeof(line), "Level: %d%%", currentPercent);
  display.drawStr(0, 28, line);

  snprintf(line, sizeof(line), "Duty : %d/%d", currentDuty, PWM_MAX_DUTY);
  display.drawStr(0, 42, line);

  snprintf(line, sizeof(line), "Pin17 %dHz", PWM_FREQ);
  display.drawStr(0, 56, line);

  display.drawFrame(10, 16, 108, 10);
  display.drawBox(10, 16, barWidth, 10);

  display.sendBuffer();
}

void setFanSpeedPercent(int percent) {
  currentPercent = constrain(percent, 0, 100);
  currentDuty = map(currentPercent, 0, 100, 0, PWM_MAX_DUTY);

  ledcWriteChannel(PWM_CHANNEL, currentDuty);
  drawStatus();

  Serial.printf("Fan speed: %d%%, duty: %d\n", currentPercent, currentDuty);
}

void kickStartFan(int targetPercent) {
  // Many DC fans need a short full-duty kick to start reliably.
  setFanSpeedPercent(100);
  delay(1000);
  setFanSpeedPercent(targetPercent);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println();
  Serial.println("ESP32-S3 fan PWM + SSD1309 display demo start");
  Serial.printf("PWM pin: GPIO%d\n", FAN_PWM_PIN);
  Serial.printf("PWM freq: %d Hz\n", PWM_FREQ);
  Serial.printf("OLED CS=%d DC=%d RST=%d MOSI=%d SCK=%d\n",
                PIN_OLED_CS, PIN_OLED_DC, PIN_OLED_RST, PIN_OLED_MOSI, PIN_OLED_SCK);

  display.begin();
  display.setContrast(255);
  display.clearBuffer();
  display.setFont(u8g2_font_6x12_tf);
  display.drawStr(8, 20, "OLED BOOT TEST");
  display.drawStr(8, 38, "SSD1309 128x64");
  display.drawStr(8, 56, "GPIO17 FAN PWM");
  display.sendBuffer();
  delay(1200);

  ledcAttachChannel(FAN_PWM_PIN, PWM_FREQ, PWM_RESOLUTION, PWM_CHANNEL);

  setFanSpeedPercent(0);
  delay(500);
  kickStartFan(40);
}

void loop() {
  for (int speed = 30; speed <= 100; speed += 10) {
    setFanSpeedPercent(speed);
    delay(5000);
  }

  for (int speed = 100; speed >= 30; speed -= 10) {
    setFanSpeedPercent(speed);
    delay(5000);
  }
}
