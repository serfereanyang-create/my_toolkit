#include <WiFi.h>

static const char *AP_SSID = "ESP32P4_TEST";
static const char *AP_PASS = "12345678";

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("Starting ESP32-P4 WiFi AP test...");

  WiFi.mode(WIFI_AP);

  bool ok = WiFi.softAP(AP_SSID, AP_PASS);
  if (!ok) {
    Serial.println("softAP start failed");
    return;
  }

  IPAddress ip = WiFi.softAPIP();
  Serial.println("softAP started");
  Serial.print("SSID: ");
  Serial.println(AP_SSID);
  Serial.print("Password: ");
  Serial.println(AP_PASS);
  Serial.print("AP IP: ");
  Serial.println(ip);
  Serial.println("Use a phone or PC to search and connect to this WiFi hotspot.");
}

void loop() {
  static unsigned long last_ms = 0;
  unsigned long now = millis();
  if (now - last_ms >= 5000) {
    last_ms = now;
    Serial.print("Connected stations: ");
    Serial.println(WiFi.softAPgetStationNum());
  }
}
