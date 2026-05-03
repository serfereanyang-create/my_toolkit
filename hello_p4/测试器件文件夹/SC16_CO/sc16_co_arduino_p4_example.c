#include <Arduino.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>

#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_timer.h"

// Arduino IDE + ESP32-P4 example
// Board: JC-ESP32P4-M3-DEV
// Sensor: SC16-CO

#ifndef CO_RX_PIN_NUM
#define CO_RX_PIN_NUM 32
#endif

#ifndef CO_TX_PIN_NUM
#define CO_TX_PIN_NUM 33
#endif

static const gpio_num_t CO_RX_PIN = (gpio_num_t)CO_RX_PIN_NUM;
static const gpio_num_t CO_TX_PIN = (gpio_num_t)CO_TX_PIN_NUM;
static const int CO_BAUD = 9600;
static const uart_port_t CO_UART = UART_NUM_1;

static uint8_t calc_frame_checksum(const uint8_t *frame, size_t len) {
    uint8_t sum = 0;
    for (size_t i = 0; i < len; ++i) {
        sum = (uint8_t)(sum + frame[i]);
    }
    return (uint8_t)(~sum);
}

static bool read_co_frame(uint16_t *co_ppm) {
    uint8_t frame[9];

    int64_t start_ms = esp_timer_get_time() / 1000;
    while ((esp_timer_get_time() / 1000) - start_ms < 1200) {
        uint8_t byte = 0;
        int len = uart_read_bytes(CO_UART, &byte, 1, pdMS_TO_TICKS(10));
        if (len == 1 && byte == 0xFF) {
            frame[0] = 0xFF;

            int got = uart_read_bytes(CO_UART, &frame[1], 8, pdMS_TO_TICKS(100));
            if (got != 8) {
                Serial.println("Read failed: incomplete frame");
                return false;
            }

            if (frame[1] != 0x18 || frame[2] != 0x04) {
                Serial.print("Unknown frame: ");
                for (size_t i = 0; i < sizeof(frame); ++i) {
                    if (frame[i] < 0x10) {
                        Serial.print('0');
                    }
                    Serial.print(frame[i], HEX);
                    Serial.print(' ');
                }
                Serial.println();
                return false;
            }

            uint8_t checksum = calc_frame_checksum(frame, 8);
            if (checksum != frame[8]) {
                Serial.print("Checksum mismatch: calc=0x");
                Serial.print(checksum, HEX);
                Serial.print(" recv=0x");
                Serial.println(frame[8], HEX);
                return false;
            }

            *co_ppm = ((uint16_t)frame[4] << 8) | frame[5];
            return true;
        }

        delay(10);
    }

    Serial.println("Read failed: timeout waiting for frame header");
    return false;
}

static const char *get_label(uint16_t co_ppm) {
    if (co_ppm > 200) {
        return "danger";
    }
    if (co_ppm > 50) {
        return "warning";
    }
    return "normal";
}

void setup(void) {
    Serial.begin(115200);
    delay(1000);
    Serial.println();
    Serial.println("SC16-CO Arduino P4 example start");

    uart_config_t uart_config = {};
    uart_config.baud_rate = CO_BAUD;
    uart_config.data_bits = UART_DATA_8_BITS;
    uart_config.parity = UART_PARITY_DISABLE;
    uart_config.stop_bits = UART_STOP_BITS_1;
    uart_config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    uart_config.rx_flow_ctrl_thresh = 0;
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
    uart_config.source_clk = UART_SCLK_DEFAULT;
#endif

    uart_driver_install(CO_UART, 256, 0, 0, NULL, 0);
    uart_param_config(CO_UART, &uart_config);
    uart_set_pin(CO_UART, CO_TX_PIN, CO_RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);

    Serial.print("UART ready. RX=");
    Serial.print((int)CO_RX_PIN);
    Serial.print(" TX=");
    Serial.print((int)CO_TX_PIN);
    Serial.print(" Baud=");
    Serial.println(CO_BAUD);
}

void loop(void) {
    static uint32_t miss_count = 0;
    uint16_t co_ppm = 0;

    if (read_co_frame(&co_ppm)) {
        miss_count = 0;
        Serial.print("CO = ");
        Serial.print(co_ppm);
        Serial.print(" ppm    status = ");
        Serial.println(get_label(co_ppm));
    } else {
        miss_count++;
        if (miss_count >= 3) {
            Serial.print("Missed valid frames: ");
            Serial.println(miss_count);
        }
    }

    delay(50);
}
