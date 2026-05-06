#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_camera.h"

// ===== ESP32-S3-CAM 引脚配置 =====
// 你的 DIP-16 模块引脚定义可能和常见开发板不同。
// 如果摄像头初始化失败，请按商家原理图修改下面 GPIO。
#ifndef CAM_PIN_PWDN
#define CAM_PIN_PWDN    -1
#endif
#ifndef CAM_PIN_RESET
#define CAM_PIN_RESET   -1
#endif
#ifndef CAM_PIN_XCLK
#define CAM_PIN_XCLK    15
#endif
#ifndef CAM_PIN_SIOD
#define CAM_PIN_SIOD    4
#endif
#ifndef CAM_PIN_SIOC
#define CAM_PIN_SIOC    5
#endif
#ifndef CAM_PIN_D7
#define CAM_PIN_D7      16
#endif
#ifndef CAM_PIN_D6
#define CAM_PIN_D6      17
#endif
#ifndef CAM_PIN_D5
#define CAM_PIN_D5      18
#endif
#ifndef CAM_PIN_D4
#define CAM_PIN_D4      12
#endif
#ifndef CAM_PIN_D3
#define CAM_PIN_D3      10
#endif
#ifndef CAM_PIN_D2
#define CAM_PIN_D2      8
#endif
#ifndef CAM_PIN_D1
#define CAM_PIN_D1      9
#endif
#ifndef CAM_PIN_D0
#define CAM_PIN_D0      11
#endif
#ifndef CAM_PIN_VSYNC
#define CAM_PIN_VSYNC   6
#endif
#ifndef CAM_PIN_HREF
#define CAM_PIN_HREF    7
#endif
#ifndef CAM_PIN_PCLK
#define CAM_PIN_PCLK    13
#endif

#define XCLK_FREQ_HZ        20000000
#define BENCH_ROUNDS        120
#define WARMUP_ROUNDS       10
#define MAX_INPUT_SIZE      240

static const char *TAG = "S3_CAM_BENCH";
static uint8_t *resize_buf;
static volatile uint32_t sink_value;

typedef struct {
    framesize_t frame_size;
    const char *name;
    int out_size;
} bench_case_t;

static const bench_case_t BENCH_CASES[] = {
    {FRAMESIZE_96X96,   "96x96",   96},
    {FRAMESIZE_QQVGA,   "160x120", 128},
#if defined(FRAMESIZE_240X240)
    {FRAMESIZE_240X240, "240x240", 240},
#endif
    {FRAMESIZE_QVGA,    "320x240", 240},
};

static int64_t now_us(void) {
    return esp_timer_get_time();
}

static void resize_gray_nn(const uint8_t *src, int sw, int sh, uint8_t *dst, int dw, int dh) {
    for (int y = 0; y < dh; y++) {
        int sy = (y * sh) / dh;
        const uint8_t *src_row = src + sy * sw;
        uint8_t *dst_row = dst + y * dw;
        for (int x = 0; x < dw; x++) {
            int sx = (x * sw) / dw;
            dst_row[x] = src_row[sx];
        }
    }
}

static uint32_t fake_infer_like_work(const uint8_t *buf, int len) {
    uint32_t sum = 0;
    uint32_t edge = 0;
    for (int i = 1; i < len; i++) {
        sum += buf[i];
        edge += (uint8_t)(buf[i] > buf[i - 1] ? buf[i] - buf[i - 1] : buf[i - 1] - buf[i]);
    }
    return sum ^ (edge << 1);
}

static void print_mem(const char *stage) {
    ESP_LOGI(TAG, "%s heap=%" PRIu32 " psram=%" PRIu32,
             stage,
             (uint32_t)heap_caps_get_free_size(MALLOC_CAP_8BIT),
             (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

static esp_err_t camera_init(void) {
    camera_config_t config = {
        .pin_pwdn = CAM_PIN_PWDN,
        .pin_reset = CAM_PIN_RESET,
        .pin_xclk = CAM_PIN_XCLK,
        .pin_sccb_sda = CAM_PIN_SIOD,
        .pin_sccb_scl = CAM_PIN_SIOC,
        .pin_d7 = CAM_PIN_D7,
        .pin_d6 = CAM_PIN_D6,
        .pin_d5 = CAM_PIN_D5,
        .pin_d4 = CAM_PIN_D4,
        .pin_d3 = CAM_PIN_D3,
        .pin_d2 = CAM_PIN_D2,
        .pin_d1 = CAM_PIN_D1,
        .pin_d0 = CAM_PIN_D0,
        .pin_vsync = CAM_PIN_VSYNC,
        .pin_href = CAM_PIN_HREF,
        .pin_pclk = CAM_PIN_PCLK,
        .xclk_freq_hz = XCLK_FREQ_HZ,
        .ledc_timer = LEDC_TIMER_0,
        .ledc_channel = LEDC_CHANNEL_0,
        .pixel_format = PIXFORMAT_GRAYSCALE,
        .frame_size = FRAMESIZE_QQVGA,
        .jpeg_quality = 20,
        .fb_count = 2,
        .fb_location = CAMERA_FB_IN_PSRAM,
        .grab_mode = CAMERA_GRAB_LATEST,
    };

    return esp_camera_init(&config);
}

static void run_one_case(const bench_case_t *bc) {
    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor) {
        sensor->set_framesize(sensor, bc->frame_size);
        sensor->set_pixformat(sensor, PIXFORMAT_GRAYSCALE);
        vTaskDelay(pdMS_TO_TICKS(300));
    }

    int64_t cap_total = 0;
    int64_t resize_total = 0;
    int64_t infer_total = 0;
    int ok = 0;

    ESP_LOGI(TAG, "CASE start frame=%s input=%dx%d rounds=%d", bc->name, bc->out_size, bc->out_size, BENCH_ROUNDS);

    for (int i = 0; i < BENCH_ROUNDS + WARMUP_ROUNDS; i++) {
        int64_t t0 = now_us();
        camera_fb_t *fb = esp_camera_fb_get();
        int64_t t1 = now_us();
        if (!fb) {
            ESP_LOGW(TAG, "capture failed at %d", i);
            continue;
        }

        int64_t t2 = now_us();
        if (fb->format == PIXFORMAT_GRAYSCALE && fb->width > 0 && fb->height > 0) {
            resize_gray_nn(fb->buf, fb->width, fb->height, resize_buf, bc->out_size, bc->out_size);
        } else {
            int copy_len = fb->len;
            int max_len = bc->out_size * bc->out_size;
            if (copy_len > max_len) copy_len = max_len;
            memcpy(resize_buf, fb->buf, copy_len);
        }
        int64_t t3 = now_us();

        sink_value ^= fake_infer_like_work(resize_buf, bc->out_size * bc->out_size);
        int64_t t4 = now_us();

        int w = fb->width;
        int h = fb->height;
        int len = fb->len;
        esp_camera_fb_return(fb);

        if (i >= WARMUP_ROUNDS) {
            cap_total += t1 - t0;
            resize_total += t3 - t2;
            infer_total += t4 - t3;
            ok++;
        }

        if (i == WARMUP_ROUNDS) {
            ESP_LOGI(TAG, "sample fb=%dx%d len=%d", w, h, len);
        }
    }

    if (ok > 0) {
        double cap_ms = (double)cap_total / ok / 1000.0;
        double resize_ms = (double)resize_total / ok / 1000.0;
        double infer_ms = (double)infer_total / ok / 1000.0;
        double total_ms = cap_ms + resize_ms + infer_ms;
        double fps = 1000.0 / total_ms;
        ESP_LOGI(TAG, "RESULT frame=%s input=%dx%d cap=%.2fms resize=%.2fms fake_infer=%.2fms total=%.2fms fps=%.2f",
                 bc->name, bc->out_size, bc->out_size, cap_ms, resize_ms, infer_ms, total_ms, fps);
    }
    print_mem("after case");
}

void app_main(void) {
    ESP_LOGI(TAG, "ESP32-S3 camera benchmark start");
    print_mem("boot");

    resize_buf = heap_caps_malloc(MAX_INPUT_SIZE * MAX_INPUT_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!resize_buf) {
        resize_buf = heap_caps_malloc(MAX_INPUT_SIZE * MAX_INPUT_SIZE, MALLOC_CAP_8BIT);
    }
    if (!resize_buf) {
        ESP_LOGE(TAG, "alloc resize_buf failed");
        return;
    }

    esp_err_t err = camera_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "camera init failed: %s. Check camera pins in main.c", esp_err_to_name(err));
        return;
    }
    print_mem("camera ready");

    while (true) {
        for (int i = 0; i < (int)(sizeof(BENCH_CASES) / sizeof(BENCH_CASES[0])); i++) {
            run_one_case(&BENCH_CASES[i]);
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
        ESP_LOGI(TAG, "all cases done, sink=%" PRIu32, sink_value);
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
}
