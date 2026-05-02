# SGP30 Test

This folder contains a simple `ESP32-P4 + SGP30` test sketch and sample output data.

## Files

- `sgp30_test.ino`: Arduino sketch for reading SGP30 values over I2C
- `sgp30.csv`: Example output data captured from serial logs
- `sgp30_plot.png`: Plot generated from the captured CSV data

## What The Sketch Does

The sketch:

- initializes I2C on the ESP32-P4
- initializes the SGP30 sensor
- reads `eCO2` and `TVOC` once per second
- prints one CSV-style line to the serial port per sample

Serial output format:

```text
index,co2_ppm,tvoc_ppb
1,400,0
2,400,0
...
```

This matches the format used in `sgp30.csv`.

## Board And Core

- Board package: `esp32 by Espressif Systems`
- Tested target: `ESP32-P4 Dev Board`
- Core version used during recovery: `3.3.8`

If the IDE reports `Unknown FQBN: board esp32:esp32:esp32p4 not found`, the `esp32 3.3.8` core is not fully installed yet.

## Required Arduino Library

Install this library from the Arduino Library Manager before compiling:

- `Adafruit SGP30 Sensor`

The sketch uses:

```cpp
#include <Adafruit_SGP30.h>
```

## I2C Pins

The sketch currently uses:

```cpp
static const int I2C_SDA_PIN = 8;
static const int I2C_SCL_PIN = 9;
```

If your ESP32-P4 board or wiring uses different I2C pins, update these two constants in `sgp30_test.ino`.

## How To Run

1. Open `sgp30_test.ino` in Arduino IDE.
2. Select `Tools -> Board -> ESP32-P4 Dev Board`.
3. Select the correct serial port under `Tools -> Port`.
4. Verify the `Adafruit SGP30 Sensor` library is installed.
5. Compile and upload.
6. Open Serial Monitor at `115200` baud.

## Expected Behavior

On startup, the sketch will print:

- startup information
- whether the SGP30 was detected
- a CSV header line
- one sample per second

If the sensor is not detected, the sketch prints:

```text
# ERROR: SGP30 not found. Check wiring and I2C pins.
```

## Notes

- `sgp30.csv` is sample captured data, not generated automatically by the sketch.
- If you want to save fresh data, copy the serial output into a `.csv` file manually or use a serial logging tool.
