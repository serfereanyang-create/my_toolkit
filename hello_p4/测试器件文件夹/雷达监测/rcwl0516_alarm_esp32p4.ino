const int RADAR_PIN = 1; 
const int BUZZER_PIN = 5; 
 
const unsigned long ALARM_HOLD_MS = 3000; 
const unsigned long LOOP_DELAY_MS = 20; 
 
unsigned long alarmUntil = 0; 
bool lastRadarState = false; 
 
void setup() { 
  Serial.begin(115200); 
  delay(300); 
  pinMode(RADAR_PIN, INPUT); 
  pinMode(BUZZER_PIN, OUTPUT); 
  digitalWrite(BUZZER_PIN, HIGH); 
  Serial.println("RCWL-0516 alarm demo start"); 
} 
 
void loop() { 
  bool motionDetected = digitalRead(RADAR_PIN) == HIGH; 
  unsigned long now = millis(); 
  if (motionDetected) { 
    alarmUntil = now + ALARM_HOLD_MS; 
    if (!lastRadarState) { 
      Serial.println("Motion detected -> alarm ON"); 
    } 
  } else if (lastRadarState) { 
    Serial.println("Motion signal cleared"); 
  } 
  if (now < alarmUntil) { 
    digitalWrite(BUZZER_PIN, HIGH); 
  } else { 
    digitalWrite(BUZZER_PIN, LOW); 
  } 
  lastRadarState = motionDetected; 
  delay(LOOP_DELAY_MS); 
}
