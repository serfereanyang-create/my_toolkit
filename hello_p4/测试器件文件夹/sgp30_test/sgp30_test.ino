void setup() {
    // 不要 while(!Serial)，不要长 delay
    Serial.begin(115200);
}

void loop() {
    static unsigned long lastPrint = 0;
    unsigned long now = millis();
    
    // 非阻塞打印，每秒一次
    if (now - lastPrint >= 1000) {
        lastPrint = now;
        Serial.println("OK");
    }
}