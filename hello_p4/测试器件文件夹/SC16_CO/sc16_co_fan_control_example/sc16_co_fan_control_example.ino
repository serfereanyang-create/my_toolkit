#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/uart.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Example file:
// Read SC16-CO concentration and control a fan on GPIO4 with PWM.
// This file is separate from main.c so you can merge pieces manually.

#ifndef CO_RX_PIN_NUM
#define CO_RX_PIN_NUM 32
#endif

#ifndef CO_TX_PIN_NUM
#define CO_TX_PIN_NUM 33
#endif

#ifndef FAN_PWM_PIN_NUM
#define FAN_PWM_PIN_NUM 4
#endif

static const gpio_num_t CO_RX_PIN = (gpio_num_t)CO_RX_PIN_NUM;
static const gpio_num_t CO_TX_PIN = (gpio_num_t)CO_TX_PIN_NUM;
static const int CO_BAUD = 9600;
static const uart_port_t CO_UART = UART_NUM_1;

static const gpio_num_t FAN_PWM_PIN = (gpio_num_t)FAN_PWM_PIN_NUM;
static const ledc_mode_t FAN_LEDC_MODE = LEDC_LOW_SPEED_MODE;
static const ledc_timer_t FAN_LEDC_TIMER = LEDC_TIMER_0;
static const ledc_channel_t FAN_LEDC_CHANNEL = LEDC_CHANNEL_0;
static const uint32_t FAN_PWM_FREQ_HZ = 20000;
static const ledc_timer_bit_t FAN_PWM_RESOLUTION = LEDC_TIMER_8_BIT;
static const uint32_t FAN_PWM_MAX_DUTY = 255;
static const uint32_t FAN_START_BOOST_MS = 800;

static const char *TAG = "SC16-CO-FAN";

typedef struct {
    uint16_t ppm_min;
    uint16_t ppm_max;
    int fan_percent;
    const char *fan_level;
} co_fan_rule_t;

static const co_fan_rule_t CO_FAN_RULES[] = {
    {0, 30, 30, "idle_low"},
    {31, 50, 35, "low"},
    {51, 100, 50, "medium"},
    {101, 150, 70, "high"},
    {151, 200, 85, "very_high"},
    {201, UINT16_MAX, 100, "max"},
};

static int s_current_fan_percent = -1;

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
                return false;
            }

            if (frame[1] != 0x18 || frame[2] != 0x04) {
                return false;
            }

            uint8_t checksum = calc_frame_checksum(frame, 8);
            if (checksum != frame[8]) {
                return false;
            }

            *co_ppm = ((uint16_t)frame[4] << 8) | frame[5];
            return true;
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }

    return false;
}

static int clamp_percent(int percent) {
    if (percent < 0) {
        return 0;
    }
    if (percent > 100) {
        return 100;
    }
    return percent;
}

static uint32_t percent_to_duty(int percent) {
    percent = clamp_percent(percent);
    return (uint32_t)((percent * FAN_PWM_MAX_DUTY) / 100);
}

static int get_fan_percent_for_co(uint16_t co_ppm) {
    for (size_t i = 0; i < sizeof(CO_FAN_RULES) / sizeof(CO_FAN_RULES[0]); ++i) {
        if (co_ppm >= CO_FAN_RULES[i].ppm_min && co_ppm <= CO_FAN_RULES[i].ppm_max) {
            return CO_FAN_RULES[i].fan_percent;
        }
    }
    return 100;
}

static const char *get_fan_level_for_co(uint16_t co_ppm) {
    for (size_t i = 0; i < sizeof(CO_FAN_RULES) / sizeof(CO_FAN_RULES[0]); ++i) {
        if (co_ppm >= CO_FAN_RULES[i].ppm_min && co_ppm <= CO_FAN_RULES[i].ppm_max) {
            return CO_FAN_RULES[i].fan_level;
        }
    }
    return "max";
}

static void fan_set_percent(int percent) {
    uint32_t duty = percent_to_duty(percent);
    ledcWriteChannel(FAN_LEDC_CHANNEL, duty);
    s_current_fan_percent = clamp_percent(percent);
}

static void fan_start_then_set_percent(int percent) {
    percent = clamp_percent(percent);

    if (percent <= 0) {
        fan_set_percent(0);
        return;
    }

    if (s_current_fan_percent <= 0 && percent < 100) {
        fan_set_percent(100);
        vTaskDelay(pdMS_TO_TICKS(FAN_START_BOOST_MS));
    }

    fan_set_percent(percent);
}

static uint32_t s_miss_count = 0;
static int s_last_target_percent = -1;

void setup() {
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

    ESP_ERROR_CHECK(uart_driver_install(CO_UART, 256, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(CO_UART, &uart_config));
    ESP_ERROR_CHECK(uart_set_pin(CO_UART, CO_TX_PIN, CO_RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

    ledcAttachChannel(FAN_PWM_PIN, FAN_PWM_FREQ_HZ, 8, FAN_LEDC_CHANNEL);

    fan_set_percent(0);
    delay(500);
    fan_start_then_set_percent(30);
}

void loop() {
    uint16_t co_ppm = 0;

    if (read_co_frame(&co_ppm)) {
        int target_percent = get_fan_percent_for_co(co_ppm);
        const char *fan_level = get_fan_level_for_co(co_ppm);
        s_miss_count = 0;

        if (target_percent != s_last_target_percent) {
            fan_start_then_set_percent(target_percent);
            s_last_target_percent = target_percent;
        }

        ESP_LOGI(TAG,
                 "CO=%" PRIu16 " ppm fan=%d%% (%s)",
                 co_ppm,
                 target_percent,
                 fan_level);
    } else {
        s_miss_count++;
        if (s_miss_count >= 3) {
            ESP_LOGW(TAG, "Missed %" PRIu32 " consecutive valid frames", s_miss_count);
        }
    }

    delay(200);
}
