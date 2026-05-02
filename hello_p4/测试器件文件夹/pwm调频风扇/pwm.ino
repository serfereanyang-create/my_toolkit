const int FAN_PWM_PIN = 4;

const int PWM_CHANNEL = 0;
const int PWM_FREQ = 20000;      // 20kHz
const int PWM_RESOLUTION = 8;    // 0~255

void setFanSpeedPercent(int percent) {
  percent = constrain(percent, 0, 100);

  int duty = map(percent, 0, 100, 0, 255);
  ledcWriteChannel(PWM_CHANNEL, duty);
}

void startFanThenSet(int percent) {
  // 2线风扇低速可能起不来，先满速冲一下
  setFanSpeedPercent(100);
  delay(800);

  setFanSpeedPercent(percent);
}

void setup() {
  ledcAttachChannel(FAN_PWM_PIN, PWM_FREQ, PWM_RESOLUTION, PWM_CHANNEL);

  setFanSpeedPercent(0);
  delay(500);

  startFanThenSet(40);  // 启动后降到40%
}

void loop() {
  // 示例：慢慢加速
  for (int speed = 30; speed <= 100; speed += 5) {
    setFanSpeedPercent(speed);
    delay(10000);
  }

  // 示例：慢慢减速
  for (int speed = 100; speed >= 30; speed -= 5) {
    setFanSpeedPercent(speed);
    delay(10000);
  }
}
