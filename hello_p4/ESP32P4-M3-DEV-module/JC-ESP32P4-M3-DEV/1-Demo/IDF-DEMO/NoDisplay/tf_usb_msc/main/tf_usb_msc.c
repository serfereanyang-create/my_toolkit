#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "esp_check.h"
#include "esp_log.h"
#include "sdmmc_cmd.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"
#include "tinyusb_msc.h"
#include "class/msc/msc.h"
#include "bsp/esp32_p4_function_ev_board.h"

static const char *TAG = "tf_usb_msc";

static tinyusb_msc_storage_handle_t s_storage_hdl;

#define TUSB_DESC_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_MSC_DESC_LEN)

enum {
    ITF_NUM_MSC = 0,
    ITF_NUM_TOTAL
};

enum {
    EDPT_MSC_OUT = 0x01,
    EDPT_MSC_IN = 0x81,
};

static tusb_desc_device_t s_device_desc = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200,
    .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = 0x303A,
    .idProduct = 0x4002,
    .bcdDevice = 0x0100,
    .iManufacturer = 0x01,
    .iProduct = 0x02,
    .iSerialNumber = 0x03,
    .bNumConfigurations = 0x01,
};

static const uint8_t s_fs_config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_MSC_DESCRIPTOR(ITF_NUM_MSC, 0, EDPT_MSC_OUT, EDPT_MSC_IN, 64),
};

#if TUD_OPT_HIGH_SPEED
static const tusb_desc_device_qualifier_t s_device_qualifier = {
    .bLength = sizeof(tusb_desc_device_qualifier_t),
    .bDescriptorType = TUSB_DESC_DEVICE_QUALIFIER,
    .bcdUSB = 0x0200,
    .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .bNumConfigurations = 0x01,
    .bReserved = 0,
};

static const uint8_t s_hs_config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_MSC_DESCRIPTOR(ITF_NUM_MSC, 0, EDPT_MSC_OUT, EDPT_MSC_IN, 512),
};
#endif

static const char *s_string_desc[] = {
    (const char[]) {0x09, 0x04},
    "Guition",
    "P4 TF MSC",
    "P4TF0001",
    "TF Card",
};

static void create_readme_if_missing(void)
{
    char path[128];
    struct stat st;

    snprintf(path, sizeof(path), "%s/README.TXT", BSP_SD_MOUNT_POINT);
    if (stat(path, &st) == 0) {
        return;
    }

    FILE *fp = fopen(path, "w");
    if (!fp) {
        ESP_LOGW(TAG, "failed to create %s", path);
        return;
    }

    fprintf(fp, "ESP32-P4 TF card USB MSC demo.\r\n");
    fprintf(fp, "Connect the USB3 High Speed Type-C port to a PC.\r\n");
    fclose(fp);
}

static void log_sdcard_info(void)
{
    ESP_LOGI(TAG, "TF card mounted at %s", BSP_SD_MOUNT_POINT);
    if (bsp_sdcard) {
        sdmmc_card_print_info(stdout, bsp_sdcard);
    }

    DIR *dir = opendir(BSP_SD_MOUNT_POINT);
    if (!dir) {
        ESP_LOGW(TAG, "unable to list %s", BSP_SD_MOUNT_POINT);
        return;
    }

    ESP_LOGI(TAG, "Files on TF card:");
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        ESP_LOGI(TAG, "  %s", entry->d_name);
    }
    closedir(dir);
}

static void storage_event_cb(tinyusb_msc_storage_handle_t handle, tinyusb_msc_event_t *event, void *arg)
{
    (void)handle;
    (void)arg;

    switch (event->id) {
    case TINYUSB_MSC_EVENT_MOUNT_START:
        ESP_LOGI(TAG, "switching TF card mount");
        break;
    case TINYUSB_MSC_EVENT_MOUNT_COMPLETE:
        ESP_LOGI(TAG, "TF card exposed to %s",
                 event->mount_point == TINYUSB_MSC_STORAGE_MOUNT_USB ? "USB host" : "application");
        break;
    case TINYUSB_MSC_EVENT_MOUNT_FAILED:
    case TINYUSB_MSC_EVENT_FORMAT_REQUIRED:
        ESP_LOGE(TAG, "TF card mount failed or needs formatting");
        break;
    default:
        break;
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "mounting TF card");
    ESP_ERROR_CHECK(bsp_sdcard_mount());
    create_readme_if_missing();
    log_sdcard_info();

    tinyusb_msc_storage_config_t storage_cfg = {
        .mount_point = TINYUSB_MSC_STORAGE_MOUNT_USB,
        .fat_fs = {
            .base_path = NULL,
            .config.max_files = 5,
            .format_flags = 0,
        },
        .medium.card = bsp_sdcard,
    };

    ESP_LOGI(TAG, "creating TinyUSB MSC storage");
    ESP_ERROR_CHECK(tinyusb_msc_new_storage_sdmmc(&storage_cfg, &s_storage_hdl));
    ESP_ERROR_CHECK(tinyusb_msc_set_storage_callback(storage_event_cb, NULL));

    tinyusb_config_t tusb_cfg = TINYUSB_DEFAULT_CONFIG();
    tusb_cfg.descriptor.device = &s_device_desc;
    tusb_cfg.descriptor.full_speed_config = s_fs_config_desc;
    tusb_cfg.descriptor.string = s_string_desc;
    tusb_cfg.descriptor.string_count = sizeof(s_string_desc) / sizeof(s_string_desc[0]);
#if TUD_OPT_HIGH_SPEED
    tusb_cfg.descriptor.high_speed_config = s_hs_config_desc;
    tusb_cfg.descriptor.qualifier = &s_device_qualifier;
#endif

    ESP_LOGI(TAG, "starting USB MSC");
    ESP_ERROR_CHECK(tinyusb_driver_install(&tusb_cfg));
    ESP_LOGI(TAG, "ready: connect the High speed USB port to your computer");
}
