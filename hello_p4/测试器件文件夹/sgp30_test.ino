#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"

#define I2C_SCL_IO  46
#define I2C_SDA_IO  47

static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t sgp30_dev;

static uint8_t crc8(uint8_t *data, uint8_t len) {
    uint8_t crc = 0xFF;
    for (uint8_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (uint8_t j = 0; j < 8; j++) {
            crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : (crc << 1);
        }
    }
}

void app_main(void)
{
    printf("time,CO2_ppm,TVOC_ppb\n");   // CSV表头

    // I2C初始化
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = 0, .sda_io_num = I2C_SDA_IO, .scl_io_num = I2C_SCL_IO,
        .clk_source = I2C_CLK_SRC_DEFAULT, .flags.enable_internal_pullup = true,
    };
    i2c_new_master_bus(&bus_cfg, &bus);

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = 0x58,
        .scl_speed_hz = 50000,
    };
    i2c_master_bus_add_device(bus, &dev_cfg, &sgp30_dev);

    // SGP30初始化
    uint8_t cmd[2] = {0x20, 0x03};
    i2c_master_transmit(sgp30_dev, cmd, 2, 100);
    vTaskDelay(pdMS_TO_TICKS(100));

    uint32_t seconds = 0;

    while(1) {
        uint8_t measure[2] = {0x20, 0x08};
        uint8_t data[6];

        i2c_master_transmit(sgp30_dev, measure, 2, 100);
        vTaskDelay(pdMS_TO_TICKS(30));

        if (i2c_master_receive(sgp30_dev, data, 6, 100) == ESP_OK) {
            if (crc8(&data[0], 2) == data[2] && crc8(&data[3], 2) == data[5]) {
                uint16_t co2  = (data[0] << 8) | data[1];
                uint16_t tvoc = (data[3] << 8) | data[4];
                printf("%lu,%d,%d\n", seconds, co2, tvoc);
            } else {
                printf("%lu,CRC_ERROR,CRC_ERROR\n", seconds);
            }
        } else {
            printf("%lu,READ_FAIL,READ_FAIL\n", seconds);
        }

        seconds++;
        vTaskDelay(pdMS_TO_TICKS(1000));
    }