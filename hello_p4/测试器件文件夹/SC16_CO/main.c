#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_timer.h"

// ===== 根据你的接线修改 =====
// 当前按 JC-ESP32P4-M3-DEV 的 ESP32-P4 GPIO 连接 SC16-CO:
// Pin1 Vin  -> 5V
// Pin4 GND  -> GND
// Pin2 TXD  -> GPIO32 (ESP32-P4 RX)
// Pin3 RXD  -> GPIO33 (ESP32-P4 TX)
#ifndef CO_RX_PIN_NUM
#define CO_RX_PIN_NUM 32
#endif

#ifndef CO_TX_PIN_NUM
#define CO_TX_PIN_NUM 33
#endif

static const gpio_num_t CO_RX_PIN = (gpio_num_t)CO_RX_PIN_NUM;  // ESP32-P4 RX <- 模组 TXD
static const gpio_num_t CO_TX_PIN = (gpio_num_t)CO_TX_PIN_NUM;  // ESP32-P4 TX -> 模组 RXD
static const int CO_BAUD = 9600;

static const uart_port_t CO_UART = UART_NUM_1;
static const char *TAG = "SC16-CO";

static uint8_t calc_frame_checksum(const uint8_t *frame, size_t len) {
    uint8_t sum = 0;
    for (size_t i = 0; i < len; ++i) {
        sum = (uint8_t)(sum + frame[i]);
    }
    return (uint8_t)(~sum);
}

// 读取一帧 9 字节数据
static bool read_co_frame(uint16_t *co_ppm) {
    uint8_t frame[9];

    int64_t start_ms = esp_timer_get_time() / 1000;
    while ((esp_timer_get_time() / 1000) - start_ms < 1200) {
        uint8_t byte = 0;
        int len = uart_read_bytes(CO_UART, &byte, 1, pdMS_TO_TICKS(10));
        if (len == 1) {
            if (byte == 0xFF) {
                frame[0] = 0xFF;

                int got = uart_read_bytes(CO_UART, &frame[1], 8, pdMS_TO_TICKS(100));
                if (got != 8) {
                    ESP_LOGW(TAG, "读取失败: 数据帧不完整");
                    return false;
                }

                if (frame[1] != 0x18 || frame[2] != 0x04) {
                    ESP_LOGW(TAG,
                             "未知数据帧: %02X %02X %02X %02X %02X %02X %02X %02X %02X",
                             frame[0], frame[1], frame[2], frame[3], frame[4],
                             frame[5], frame[6], frame[7], frame[8]);
                    return false;
                }

                uint8_t checksum = calc_frame_checksum(frame, 8);
                if (checksum != frame[8]) {
                    ESP_LOGW(TAG,
                             "校验失败: calc=0x%02X recv=0x%02X frame=%02X %02X %02X %02X %02X %02X %02X %02X %02X",
                             checksum, frame[8],
                             frame[0], frame[1], frame[2], frame[3], frame[4],
                             frame[5], frame[6], frame[7], frame[8]);
                    return false;
                }

                *co_ppm = ((uint16_t)frame[4] << 8) | frame[5];
                return true;
            }
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }

    ESP_LOGW(TAG, "读取失败: 等待帧头超时");
    return false;
}

static const char *get_label(uint16_t co_ppm) {
    if (co_ppm > 200) return "danger";
    if (co_ppm > 50)  return "warning";
    return "normal";
}

void app_main(void) {
    ESP_LOGI(TAG, "");
    ESP_LOGI(TAG, "SC16-CO 模组检测开始");

    const uart_config_t uart_config = {
        .baud_rate = CO_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .rx_flow_ctrl_thresh = 0,
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
        .source_clk = UART_SCLK_DEFAULT,
#endif
    };

    ESP_ERROR_CHECK(uart_driver_install(CO_UART, 256, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(CO_UART, &uart_config));
    ESP_ERROR_CHECK(uart_set_pin(CO_UART, CO_TX_PIN, CO_RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

    ESP_LOGI(TAG, "UART1 已启动, RX=%d, TX=%d, Baud=%d", CO_RX_PIN, CO_TX_PIN, CO_BAUD);

    while (true) {
        uint16_t co_ppm = 0;
        static uint32_t miss_count = 0;

        if (read_co_frame(&co_ppm)) {
            miss_count = 0;
            ESP_LOGI(TAG, "CO = %" PRIu16 " ppm    状态 = %s", co_ppm, get_label(co_ppm));
        } else {
            miss_count++;
            if (miss_count >= 3) {
                ESP_LOGW(TAG, "连续 %" PRIu32 " 次未读到有效数据", miss_count);
            }
        }

        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
