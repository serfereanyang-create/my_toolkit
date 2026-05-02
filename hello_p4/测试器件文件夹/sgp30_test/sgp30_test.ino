// ESP32-P4 + SGP30 basic test
// Output format matches sgp30.csv: index,co2_ppm,tvoc_ppb

#include <Wire.h>
#include <Adafruit_SGP30.h>

// Adjust these pins if your ESP32-P4 board routes I2C differently.
static const int I2C_SDA_PIN = 8;
static const int I2C_SCL_PIN = 9;
static const uint32_t SAMPLE_INTERVAL_MS = 1000;

Adafruit_SGP30 sgp;

uint32_t sampleIndex = 0;
uint32_t lastSampleMs = 0;
bool baselinePrinted = false;

void printSensorRow() {
  sampleIndex++;
  Serial.print(sampleIndex);
  Serial.print(',');
  Serial.print(sgp.eCO2);
  Serial.print(',');
  Serial.println(sgp.TVOC);
}

void printBaselineOnce() {
  if (baselinePrinted) {
    return;
  }

  uint16_t eco2Base = 0;
  uint16_t tvocBase = 0;
  if (sgp.getIAQBaseline(&eco2Base, &tvocBase)) {
    Serial.print("# baseline_eco2=0x");
    Serial.print(eco2Base, HEX);
    Serial.print(", baseline_tvoc=0x");
    Serial.println(tvocBase, HEX);
    baselinePrinted = true;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1200);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  Serial.println();
  Serial.println("# SGP30 test starting");
  Serial.print("# I2C SDA=");
  Serial.print(I2C_SDA_PIN);
  Serial.print(", SCL=");
  Serial.println(I2C_SCL_PIN);

  if (!sgp.begin()) {
    Serial.println("# ERROR: SGP30 not found. Check wiring and I2C pins.");
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

  Serial.println("index,co2_ppm,tvoc_ppb");
  lastSampleMs = millis();
}

void loop() {
  if (millis() - lastSampleMs < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSampleMs = millis();

  if (!sgp.IAQmeasure()) {
    Serial.println("# ERROR: IAQmeasure failed");
    return;
  }

  printSensorRow();

  // The baseline only becomes meaningful after the sensor has been running.
  if (sampleIndex >= 30) {
    printBaselineOnce();
  }
}
