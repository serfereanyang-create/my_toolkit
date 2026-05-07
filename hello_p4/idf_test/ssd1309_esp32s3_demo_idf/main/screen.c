#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define OLED_WIDTH 128
#define OLED_HEIGHT 64
#define OLED_PAGES (OLED_HEIGHT / 8)
#define OLED_BUFFER_SIZE (OLED_WIDTH * OLED_PAGES)
#define OLED_SPI_CLOCK_HZ (1 * 1000 * 1000)
#define OLED_FORCE_ALL_PIXELS_ON 1

/*
 * ESP32-S3-N16R8 wiring, using the OLED signal order:
 *   OLED GND  -> GND
 *   OLED VCC  -> 5VIN
 *   OLED CS2  -> GPIO4  (kept high)
 *   OLED FS0  -> GPIO5  (kept low for 4-wire SPI)
 *   OLED SCL  -> GPIO6  (SPI clock)
 *   OLED SDA  -> GPIO7  (SPI MOSI data)
 *   OLED DC   -> GPIO8  (data/command select)
 *   OLED CS1  -> GPIO9  (active-low SPI chip select)
 *   OLED RES  -> GPIO10 (reset)
 * GPIO11 is left free.
 */
#define PIN_OLED_CS2 4
#define PIN_OLED_FS0 5
#define PIN_OLED_SCK 6
#define PIN_OLED_MOSI 7
#define PIN_OLED_DC 8
#define PIN_OLED_CS 9
#define PIN_OLED_RST 10

static const char *TAG = "SSD1309";
static spi_device_handle_t s_oled_spi;
static uint8_t s_framebuffer[OLED_BUFFER_SIZE];
static uint32_t s_counter;

typedef struct {
    char ch;
    uint8_t columns[5];
} glyph_t;

static const glyph_t FONT[] = {
    {' ', {0x00, 0x00, 0x00, 0x00, 0x00}},
    {'+', {0x08, 0x08, 0x3E, 0x08, 0x08}},
    {'-', {0x08, 0x08, 0x08, 0x08, 0x08}},
    {':', {0x00, 0x36, 0x36, 0x00, 0x00}},
    {'0', {0x3E, 0x45, 0x49, 0x51, 0x3E}},
    {'1', {0x00, 0x21, 0x7F, 0x01, 0x00}},
    {'2', {0x23, 0x45, 0x49, 0x51, 0x21}},
    {'3', {0x22, 0x41, 0x49, 0x49, 0x36}},
    {'4', {0x18, 0x28, 0x48, 0x7F, 0x08}},
    {'5', {0x72, 0x51, 0x51, 0x51, 0x4E}},
    {'6', {0x1E, 0x29, 0x49, 0x49, 0x06}},
    {'7', {0x40, 0x47, 0x48, 0x50, 0x60}},
    {'8', {0x36, 0x49, 0x49, 0x49, 0x36}},
    {'9', {0x30, 0x49, 0x49, 0x4A, 0x3C}},
    {'A', {0x7E, 0x11, 0x11, 0x11, 0x7E}},
    {'C', {0x3E, 0x41, 0x41, 0x41, 0x22}},
    {'D', {0x7F, 0x41, 0x41, 0x22, 0x1C}},
    {'E', {0x7F, 0x49, 0x49, 0x49, 0x41}},
    {'F', {0x7F, 0x09, 0x09, 0x09, 0x01}},
    {'G', {0x3E, 0x41, 0x49, 0x49, 0x3A}},
    {'H', {0x7F, 0x08, 0x08, 0x08, 0x7F}},
    {'I', {0x00, 0x41, 0x7F, 0x41, 0x00}},
    {'M', {0x7F, 0x02, 0x0C, 0x02, 0x7F}},
    {'N', {0x7F, 0x04, 0x08, 0x10, 0x7F}},
    {'O', {0x3E, 0x41, 0x41, 0x41, 0x3E}},
    {'P', {0x7F, 0x09, 0x09, 0x09, 0x06}},
    {'S', {0x46, 0x49, 0x49, 0x49, 0x31}},
    {'T', {0x01, 0x01, 0x7F, 0x01, 0x01}},
    {'U', {0x3F, 0x40, 0x40, 0x40, 0x3F}},
    {'V', {0x1F, 0x20, 0x40, 0x20, 0x1F}},
    {'X', {0x63, 0x14, 0x08, 0x14, 0x63}},
    {'d', {0x38, 0x44, 0x44, 0x48, 0x7F}},
    {'e', {0x38, 0x54, 0x54, 0x54, 0x18}},
    {'i', {0x00, 0x44, 0x7D, 0x40, 0x00}},
    {'m', {0x7C, 0x04, 0x18, 0x04, 0x78}},
    {'n', {0x7C, 0x08, 0x04, 0x04, 0x78}},
    {'o', {0x38, 0x44, 0x44, 0x44, 0x38}},
    {'p', {0x7C, 0x14, 0x14, 0x14, 0x08}},
    {'s', {0x48, 0x54, 0x54, 0x54, 0x24}},
    {'t', {0x04, 0x3F, 0x44, 0x40, 0x20}},
    {'u', {0x3C, 0x40, 0x40, 0x20, 0x7C}},
    {'x', {0x44, 0x28, 0x10, 0x28, 0x44}},
};

static const glyph_t *find_glyph(char ch)
{
    for (size_t i = 0; i < sizeof(FONT) / sizeof(FONT[0]); ++i) {
        if (FONT[i].ch == ch) {
            return &FONT[i];
        }
    }
    return &FONT[0];
}

static esp_err_t oled_transmit(const uint8_t *data, size_t len, int dc_level)
{
    if (len == 0) {
        return ESP_OK;
    }

    gpio_set_level(PIN_OLED_DC, dc_level);

    spi_transaction_t transaction = {
        .length = len * 8,
        .tx_buffer = data,
    };

    return spi_device_polling_transmit(s_oled_spi, &transaction);
}

static esp_err_t oled_command(uint8_t command)
{
    return oled_transmit(&command, 1, 0);
}

static esp_err_t oled_command_arg(uint8_t command, uint8_t arg)
{
    ESP_RETURN_ON_ERROR(oled_command(command), TAG, "send command 0x%02X failed", command);
    return oled_transmit(&arg, 1, 0);
}

static esp_err_t oled_data(const uint8_t *data, size_t len)
{
    return oled_transmit(data, len, 1);
}

static void framebuffer_clear(void)
{
    memset(s_framebuffer, 0, sizeof(s_framebuffer));
}

static void framebuffer_set_pixel(int x, int y, bool on)
{
    if (x < 0 || x >= OLED_WIDTH || y < 0 || y >= OLED_HEIGHT) {
        return;
    }

    size_t index = x + (y / 8) * OLED_WIDTH;
    uint8_t mask = 1U << (y & 0x7);
    if (on) {
        s_framebuffer[index] |= mask;
    } else {
        s_framebuffer[index] &= (uint8_t)~mask;
    }
}

static void framebuffer_draw_char(int x, int y, char ch)
{
    const glyph_t *glyph = find_glyph(ch);
    for (int col = 0; col < 5; ++col) {
        uint8_t bits = glyph->columns[col];
        for (int row = 0; row < 7; ++row) {
            framebuffer_set_pixel(x + col, y + row, (bits >> row) & 0x1);
        }
    }
}

static void framebuffer_draw_text(int x, int y, const char *text)
{
    while (*text != '\0') {
        framebuffer_draw_char(x, y, *text);
        x += 6;
        ++text;
    }
}

static void framebuffer_draw_frame(int x, int y, int width, int height)
{
    for (int dx = 0; dx < width; ++dx) {
        framebuffer_set_pixel(x + dx, y, true);
        framebuffer_set_pixel(x + dx, y + height - 1, true);
    }

    for (int dy = 0; dy < height; ++dy) {
        framebuffer_set_pixel(x, y + dy, true);
        framebuffer_set_pixel(x + width - 1, y + dy, true);
    }
}

static void framebuffer_draw_box(int x, int y, int width, int height)
{
    for (int dy = 0; dy < height; ++dy) {
        for (int dx = 0; dx < width; ++dx) {
            framebuffer_set_pixel(x + dx, y + dy, true);
        }
    }
}

static esp_err_t oled_flush(void)
{
    for (int page = 0; page < OLED_PAGES; ++page) {
        ESP_RETURN_ON_ERROR(oled_command((uint8_t)(0xB0 | page)), TAG, "set page failed");
        ESP_RETURN_ON_ERROR(oled_command(0x00), TAG, "set low column failed");
        ESP_RETURN_ON_ERROR(oled_command(0x10), TAG, "set high column failed");
        ESP_RETURN_ON_ERROR(oled_data(&s_framebuffer[page * OLED_WIDTH], OLED_WIDTH), TAG, "write page failed");
    }
    return ESP_OK;
}

static esp_err_t oled_set_contrast(uint8_t contrast)
{
    return oled_command_arg(0x81, contrast);
}

static esp_err_t oled_init(void)
{
    const gpio_config_t gpio_cfg = {
        .pin_bit_mask = (1ULL << PIN_OLED_CS2) | (1ULL << PIN_OLED_FS0) |
                        (1ULL << PIN_OLED_DC) | (1ULL << PIN_OLED_RST),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&gpio_cfg), TAG, "gpio config failed");

    gpio_set_level(PIN_OLED_CS2, 1);
    gpio_set_level(PIN_OLED_FS0, 0);

    const spi_bus_config_t bus_config = {
        .mosi_io_num = PIN_OLED_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = PIN_OLED_SCK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = OLED_WIDTH,
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(SPI2_HOST, &bus_config, SPI_DMA_CH_AUTO), TAG, "spi bus init failed");

    const spi_device_interface_config_t dev_config = {
        .clock_speed_hz = OLED_SPI_CLOCK_HZ,
        .mode = 0,
        .spics_io_num = PIN_OLED_CS,
        .queue_size = 1,
        .flags = SPI_DEVICE_HALFDUPLEX,
    };
    ESP_RETURN_ON_ERROR(spi_bus_add_device(SPI2_HOST, &dev_config, &s_oled_spi), TAG, "spi device add failed");

    gpio_set_level(PIN_OLED_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(PIN_OLED_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(PIN_OLED_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(20));

    ESP_RETURN_ON_ERROR(oled_command(0xAE), TAG, "display off failed");
    ESP_RETURN_ON_ERROR(oled_command_arg(0xD5, 0x80), TAG, "clock set failed");
    ESP_RETURN_ON_ERROR(oled_command_arg(0xA8, 0x3F), TAG, "mux set failed");
    ESP_RETURN_ON_ERROR(oled_command_arg(0xD3, 0x00), TAG, "display offset failed");
    ESP_RETURN_ON_ERROR(oled_command_arg(0x8D, 0x14), TAG, "charge pump set failed");
    ESP_RETURN_ON_ERROR(oled_command(0x40), TAG, "start line set failed");
    ESP_RETURN_ON_ERROR(oled_command_arg(0x20, 0x02), TAG, "page mode set failed");
    ESP_RETURN_ON_ERROR(oled_command(0xA1), TAG, "segment remap failed");
    ESP_RETURN_ON_ERROR(oled_command(0xC8), TAG, "com scan direction failed");
    ESP_RETURN_ON_ERROR(oled_command_arg(0xDA, 0x12), TAG, "com pins set failed");
    ESP_RETURN_ON_ERROR(oled_set_contrast(0xFF), TAG, "contrast set failed");
    ESP_RETURN_ON_ERROR(oled_command_arg(0xD9, 0xF1), TAG, "precharge set failed");
    ESP_RETURN_ON_ERROR(oled_command_arg(0xDB, 0x34), TAG, "vcomh set failed");
    ESP_RETURN_ON_ERROR(oled_command(0xA4), TAG, "resume ram display failed");
    ESP_RETURN_ON_ERROR(oled_command(0xA6), TAG, "normal display failed");
    ESP_RETURN_ON_ERROR(oled_command(0xAF), TAG, "display on failed");
#if OLED_FORCE_ALL_PIXELS_ON
    ESP_RETURN_ON_ERROR(oled_command(0xA5), TAG, "force all pixels on failed");
#endif

    framebuffer_clear();
    return oled_flush();
}

static esp_err_t draw_screen(void)
{
    char line[32];
    uint32_t uptime_s = (uint32_t)(esp_timer_get_time() / 1000000ULL);

    framebuffer_clear();
    framebuffer_draw_text(0, 4, "ESP32-S3 + SSD1309");
    framebuffer_draw_text(0, 18, "128x64 SPI Demo");

    snprintf(line, sizeof(line), "Count: %lu", (unsigned long)s_counter);
    framebuffer_draw_text(0, 32, line);

    snprintf(line, sizeof(line), "Uptime: %lus", (unsigned long)uptime_s);
    framebuffer_draw_text(0, 46, line);

    framebuffer_draw_frame(96, 18, 28, 28);
    framebuffer_draw_box(100, 22, (int)((s_counter % 5) * 4 + 4), 20);

    return oled_flush();
}

void app_main(void)
{
    ESP_LOGI(TAG, "SSD1309 demo start");
    ESP_LOGI(TAG, "Wiring: VCC->5VIN, GND->GND, CS2=%d, FS0=%d, SCL=%d, SDA=%d, DC=%d, CS1=%d, RES=%d",
             PIN_OLED_CS2, PIN_OLED_FS0, PIN_OLED_SCK, PIN_OLED_MOSI,
             PIN_OLED_DC, PIN_OLED_CS, PIN_OLED_RST);
    ESP_LOGI(TAG, "If screen stays dark, check GPIO mapping first.");

    ESP_ERROR_CHECK(oled_init());
    ESP_ERROR_CHECK(draw_screen());

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        ++s_counter;
        ESP_ERROR_CHECK(draw_screen());
        ESP_LOGI(TAG, "Screen refresh: %lu", (unsigned long)s_counter);
    }
}
