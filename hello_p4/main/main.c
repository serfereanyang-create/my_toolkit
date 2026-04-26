#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_lcd_panel_io.h"

// 引脚定义
#define PIN_NUM_MOSI 5
#define PIN_NUM_CLK  4
#define PIN_NUM_CS   45
#define PIN_NUM_DC   46
#define PIN_NUM_RST  47

// 函数声明
static void lcd_cmd(esp_lcd_panel_io_handle_t io, uint8_t cmd)
{
    esp_lcd_panel_io_tx_param(io, cmd, NULL, 0);
}

static void lcd_data(esp_lcd_panel_io_handle_t io, uint8_t data)
{
    esp_lcd_panel_io_tx_param(io, -1, &data, 1);
}

// 主函数
void app_main(void)
{
    // ===== SPI初始化 =====
    spi_bus_config_t buscfg = {
        .sclk_io_num = PIN_NUM_CLK,
        .mosi_io_num = PIN_NUM_MOSI,
        .miso_io_num = -1,
    };
    spi_bus_initialize(SPI2_HOST, &buscfg, SPI_DMA_CH_AUTO);

    esp_lcd_panel_io_handle_t io_handle = NULL;

    esp_lcd_panel_io_spi_config_t io_config = {
        .dc_gpio_num = PIN_NUM_DC,
        .cs_gpio_num = PIN_NUM_CS,
        .pclk_hz = 10 * 1000 * 1000,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 10,
    };

    esp_lcd_new_panel_io_spi(SPI2_HOST, &io_config, &io_handle);

    // ===== RST =====
    gpio_set_direction(PIN_NUM_RST, GPIO_MODE_OUTPUT);
    gpio_set_level(PIN_NUM_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(50));
    gpio_set_level(PIN_NUM_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(50));

    // ===== 初始化 ST7735 =====
    lcd_cmd(io_handle, 0x11);
    vTaskDelay(pdMS_TO_TICKS(120));

    lcd_cmd(io_handle, 0x3A);
    lcd_data(io_handle, 0x05);

    lcd_cmd(io_handle, 0x36);
    lcd_data(io_handle, 0xC8);

    lcd_cmd(io_handle, 0x29);

    printf("init done\n");
}

while (1)
{
    // 红
    for (int i = 0; i < 80*160; i++) {
        buffer[i*2] = 0xF8;
        buffer[i*2+1] = 0x00;
    }
    esp_lcd_panel_io_tx_color(io_handle, -1, buffer, sizeof(buffer));
    printf("RED\n");
    vTaskDelay(pdMS_TO_TICKS(1000));

    // 绿
    for (int i = 0; i < 80*160; i++) {
        buffer[i*2] = 0x07;
        buffer[i*2+1] = 0xE0;
    }
    esp_lcd_panel_io_tx_color(io_handle, -1, buffer, sizeof(buffer));
    printf("GREEN\n");
    vTaskDelay(pdMS_TO_TICKS(1000));

    // 蓝
    for (int i = 0; i < 80*160; i++) {
        buffer[i*2] = 0x00;
        buffer[i*2+1] = 0x1F;
    }
    esp_lcd_panel_io_tx_color(io_handle, -1, buffer, sizeof(buffer));
    printf("BLUE\n");
    vTaskDelay(pdMS_TO_TICKS(1000));
}