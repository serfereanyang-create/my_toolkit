 #include <stdio.h>
  #include <string.h>
  #include "freertos/FreeRTOS.h"
  #include "freertos/task.h"
  #include "driver/i2c_master.h"
  #include "esp_err.h"
  #include "esp_log.h"

  #define I2C_SCL_IO              2
  #define I2C_SDA_IO              1
  #define I2C_FREQ_HZ             100000

  #define SGP30_I2C_ADDR          0x58

  static const char *TAG = "SGP30";

  static i2c_master_bus_handle_t i2c_bus_handle;
  static i2c_master_dev_handle_t sgp30_dev_handle;

  static uint8_t sgp30_crc(const uint8_t *data, int len)
  {
      uint8_t crc = 0xFF;
      for (int i = 0; i < len; i++) {
          crc ^= data[i];
          for (int b = 0; b < 8; b++) {
              if (crc & 0x80) {
                  crc = (crc << 1) ^ 0x31;
              } else {
                  crc <<= 1;
              }
          }
      }
      return crc;
  }

  static esp_err_t sgp30_write_cmd(uint16_t cmd)
  {
      uint8_t buf[2] = {
          (uint8_t)(cmd >> 8),
          (uint8_t)(cmd & 0xFF)
      };

      return i2c_master_transmit(sgp30_dev_handle, buf, sizeof(buf), -1);
  }

  static esp_err_t sgp30_read_measurement(uint16_t *eco2, uint16_t *tvoc)
  {
      uint8_t cmd[2] = {0x20, 0x08};
      uint8_t rx[6] = {0};

      esp_err_t err = i2c_master_transmit(sgp30_dev_handle, cmd, sizeof(cmd), -1);
      if (err != ESP_OK) {
          return err;
      }

      vTaskDelay(pdMS_TO_TICKS(20));

      err = i2c_master_receive(sgp30_dev_handle, rx, sizeof(rx), -1);
      if (err != ESP_OK) {
          return err;
      }

      if (sgp30_crc(&rx[0], 2) != rx[2]) {
          ESP_LOGE(TAG, "eCO2 CRC check failed");
          return ESP_ERR_INVALID_CRC;
      }

      if (sgp30_crc(&rx[3], 2) != rx[5]) {
          ESP_LOGE(TAG, "TVOC CRC check failed");
          return ESP_ERR_INVALID_CRC;
      }

      *eco2 = ((uint16_t)rx[0] << 8) | rx[1];
      *tvoc = ((uint16_t)rx[3] << 8) | rx[4];

      return ESP_OK;
  }

  static esp_err_t sgp30_iaq_init(void)
  {
      return sgp30_write_cmd(0x2003);
  }

  static esp_err_t i2c_master_init(void)
  {
      i2c_master_bus_config_t bus_config = {
          .i2c_port = 0,
          .sda_io_num = I2C_SDA_IO,
          .scl_io_num = I2C_SCL_IO,
          .clk_source = I2C_CLK_SRC_DEFAULT,
          .glitch_ignore_cnt = 7,
          .intr_priority = 0,
          .trans_queue_depth = 4,
          .flags.enable_internal_pullup = true,
      };

      ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_config, &i2c_bus_handle), TAG,
  "create i2c bus failed");

      i2c_device_config_t dev_cfg = {
          .dev_addr_length = I2C_ADDR_BIT_LEN_7,
          .device_address = SGP30_I2C_ADDR,
          .scl_speed_hz = I2C_FREQ_HZ,
      };

      ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(i2c_bus_handle, &dev_cfg,
  &sgp30_dev_handle), TAG, "add sgp30 device failed");

      return ESP_OK;
  }

  void app_main(void)
  {
      ESP_LOGI(TAG, "Starting SGP30 demo");

      ESP_ERROR_CHECK(i2c_master_init());

      vTaskDelay(pdMS_TO_TICKS(100));
      ESP_ERROR_CHECK(sgp30_iaq_init());

      ESP_LOGI(TAG, "SGP30 IAQ init done");
      ESP_LOGI(TAG, "Waiting for first readings...");

      while (1) {
          uint16_t eco2 = 0;
          uint16_t tvoc = 0;

          esp_err_t err = sgp30_read_measurement(&eco2, &tvoc);
          if (err == ESP_OK) {
              ESP_LOGI(TAG, "eCO2=%u ppm, TVOC=%u ppb", eco2, tvoc);
          } else {
              ESP_LOGE(TAG, "read failed: %s", esp_err_to_name(err));
          }

          vTaskDelay(pdMS_TO_TICKS(1000));
      }
  }