/*
 * RCWL-0516 微波雷达 + 低电平触发蜂鸣器 报警系统
 * 适用板卡: Arduino Uno / Nano / Mega 及 ESP32 系列
 * 功能: 检测到人移动后，人离开时蜂鸣器报警 3 秒
 */

// ========== 引脚定义（按实际接线修改） ==========
const int RADAR_PIN  = 2;   // RCWL-0516 OUT 引脚
const int BUZZER_PIN = 3;   // 低电平触发蜂鸣器 SIG 引脚

// ========== 参数配置 ==========
const unsigned long ALARM_HOLD_MS = 3000;   // 报警持续时间
const unsigned long LOOP_DELAY_MS  = 3000;  // 检测间隔：约 3 秒检测一次
const unsigned long STATUS_PRINT_MS = 3000; // 状态打印间隔
const int MOTION_CONFIRM_COUNT = 2;         // 连续 2 次高电平才确认有人移动
const int IDLE_CONFIRM_COUNT   = 2;         // 连续 2 次低电平才确认移动结束

// ========== 全局变量 ==========
unsigned long alarmUntil     = 0;     // 报警结束时间戳
unsigned long lastStatusTime = 0;     // 上次状态打印时间
bool lastRadarState          = false; // 上一次过滤后的雷达状态
bool alarmActive             = false; // 当前报警状态
int highCount                = 0;     // 连续高电平计数
int lowCount                 = 0;     // 连续低电平计数

void setup() {
  Serial.begin(115200);
  delay(500);  // 等待串口稳定

  pinMode(RADAR_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);  // 低电平触发：HIGH = 关闭

  // 启动信息
  Serial.println(F("========================================"));
  Serial.println(F("  RCWL-0516 雷达报警系统"));
  Serial.println(F("========================================"));
  Serial.print(F("  雷达引脚 : GPIO"));
  Serial.println(RADAR_PIN);
  Serial.print(F("  蜂鸣器引脚: GPIO"));
  Serial.println(BUZZER_PIN);
  Serial.print(F("  报警时长  : "));
  Serial.print(ALARM_HOLD_MS / 1000);
  Serial.println(F(" 秒"));
  Serial.println(F("========================================"));
  Serial.println(F("  等待雷达触发..."));
  Serial.println();
}

void loop() {
  bool rawRadarHigh = (digitalRead(RADAR_PIN) == HIGH);
  unsigned long now = millis();

  if (rawRadarHigh) {
    highCount++;
    lowCount = 0;
  } else {
    lowCount++;
    highCount = 0;
  }

  bool motionDetected = lastRadarState;
  if (!lastRadarState && highCount >= MOTION_CONFIRM_COUNT) {
    motionDetected = true;
  } else if (lastRadarState && lowCount >= IDLE_CONFIRM_COUNT) {
    motionDetected = false;
  }

  // ---- 检测到移动：刷新报警倒计时 ----
  if (motionDetected) {
    alarmUntil = now + ALARM_HOLD_MS;

    if (!lastRadarState) {
      // 上升沿：刚检测到移动
      Serial.print(F("["));
      Serial.print(now);
      Serial.println(F("] 🚶 检测到移动 -> 报警倒计时重置"));
    }
  }

  // ---- 雷达信号下降沿 ----
  if (!motionDetected && lastRadarState) {
    Serial.print(F("["));
    Serial.print(now);
    Serial.println(F("] ⏳ 移动结束，开始倒计时..."));
  }

  // ---- 报警逻辑 ----
  bool shouldAlarm = (now < alarmUntil);

  if (shouldAlarm && !alarmActive) {
    // 报警开始
    alarmActive = true;
    digitalWrite(BUZZER_PIN, LOW);  // 低电平触发：LOW = 鸣响
    Serial.print(F("["));
    Serial.print(now);
    Serial.println(F("] 🔊 蜂鸣器 ON"));
  } else if (!shouldAlarm && alarmActive) {
    // 报警结束
    alarmActive = false;
    digitalWrite(BUZZER_PIN, HIGH);  // 低电平触发：HIGH = 关闭
    Serial.print(F("["));
    Serial.print(now);
    Serial.println(F("] 🔇 蜂鸣器 OFF"));
  }

  // ---- 定期打印状态 ----
  if (now - lastStatusTime >= STATUS_PRINT_MS) {
    lastStatusTime = now;
    Serial.print(F("  [状态] 原始雷达="));
    Serial.print(rawRadarHigh ? F("高") : F("低"));
    Serial.print(F(" | 判定="));
    Serial.print(motionDetected ? F("有移动") : F("无移动"));
    Serial.print(F(" | 蜂鸣器="));
    Serial.print(alarmActive ? F("鸣响中") : F("关闭"));
    Serial.print(F(" | 剩余="));
    if (alarmActive) {
      Serial.print((alarmUntil - now) / 1000.0, 1);
      Serial.print(F("s"));
    } else {
      Serial.print(F("--"));
    }
    Serial.println();
  }

  lastRadarState = motionDetected;
  delay(LOOP_DELAY_MS);
}
