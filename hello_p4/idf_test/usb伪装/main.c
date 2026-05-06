#include <stdlib.h>

#include "esp_check.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "soc/soc_caps.h"
#include "sdmmc_cmd.h"
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 3, 0) && SOC_SDMMC_IO_POWER_EXTERNAL
#include "sd_pwr_ctrl_by_on_chip_ldo.h"
#endif
#include "class/msc/msc_device.h"
#include "tinyusb.h"
#include "tinyusb_default_config.h"
#include "tinyusb_msc.h"

static const char *TAG = "USB_MSC_SD";
static tinyusb_msc_storage_handle_t s_storage_hdl;
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 3, 0) && SOC_SDMMC_IO_POWER_EXTERNAL
static sd_pwr_ctrl_handle_t s_sd_pwr_ctrl_handle;
#endif

#define EPNUM_MSC 1
#define TUSB_DESC_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_MSC_DESC_LEN)

/*
 * ESP32-P4 SDMMC diagnostic defaults seen in the current boot log:
 *   CLK=GPIO43, CMD=GPIO44, D0=GPIO39, D1=GPIO40, D2=GPIO41, D3=GPIO42
 * Start with 1-bit mode because only CLK/CMD/D0 are required. This avoids
 * failures caused by missing D1/D2/D3 wiring or weak pull-ups during bring-up.
 */
#define SDMMC_DIAG_BUS_WIDTH        1
#define SDMMC_DIAG_FREQ_KHZ         SDMMC_FREQ_DEFAULT
#define SDMMC_DIAG_LDO_CHAN_ID      4

enum {
    ITF_NUM_MSC = 0,
    ITF_NUM_TOTAL,
};

enum {
    EDPT_MSC_OUT = 0x01,
    EDPT_MSC_IN = 0x81,
};

static tusb_desc_device_t s_device_desc = {
    .bLength = sizeof(s_device_desc),
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

static const uint8_t s_msc_fs_config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_MSC_DESCRIPTOR(ITF_NUM_MSC, 0, EDPT_MSC_OUT, EDPT_MSC_IN, 64),
};

#if (TUD_OPT_HIGH_SPEED)
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

static const uint8_t s_msc_hs_config_desc[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, TUSB_DESC_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_MSC_DESCRIPTOR(ITF_NUM_MSC, 0, EDPT_MSC_OUT, EDPT_MSC_IN, 512),
};
#endif

static const char *s_string_desc[] = {
    (const char[]) {0x09, 0x04},
    "Espressif",
    "ESP32-P4 SD MSC",
    "P4SD0001",
};

static void storage_mount_changed_cb(tinyusb_msc_storage_handle_t handle, tinyusb_msc_event_t *event, void *arg)
{
    (void)handle;
    (void)arg;

    switch (event->id) {
    case TINYUSB_MSC_EVENT_MOUNT_COMPLETE:
        ESP_LOGI(TAG, "storage mounted to %s",
                 event->mount_point == TINYUSB_MSC_STORAGE_MOUNT_USB ? "USB host" : "application");
        break;
    case TINYUSB_MSC_EVENT_MOUNT_FAILED:
    case TINYUSB_MSC_EVENT_FORMAT_REQUIRED:
        ESP_LOGE(TAG, "storage mount failed or format required");
        break;
    default:
        break;
    }
}

static esp_err_t init_sdmmc_card(sdmmc_card_t **out_card)
{
    esp_err_t ret = ESP_OK;
    bool host_init = false;
    sdmmc_card_t *card = NULL;

    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.max_freq_khz = SDMMC_DIAG_FREQ_KHZ;

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 3, 0) && SOC_SDMMC_IO_POWER_EXTERNAL
    sd_pwr_ctrl_ldo_config_t ldo_config = {
        .ldo_chan_id = SDMMC_DIAG_LDO_CHAN_ID,
    };

    ESP_LOGI(TAG, "enabling SDMMC on-chip LDO channel %d", SDMMC_DIAG_LDO_CHAN_ID);
    ESP_GOTO_ON_ERROR(sd_pwr_ctrl_new_on_chip_ldo(&ldo_config, &s_sd_pwr_ctrl_handle), clean,
                      TAG, "failed to create SDMMC on-chip LDO power control");
    host.pwr_ctrl_handle = s_sd_pwr_ctrl_handle;
#endif

    sdmmc_slot_config_t slot_config = SDMMC_SLOT_CONFIG_DEFAULT();

    slot_config.width = SDMMC_DIAG_BUS_WIDTH;
    slot_config.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;

    ESP_LOGI(TAG, "SDMMC diagnostic config: slot=%d width=%d freq=%d kHz internal_pullups=on",
             host.slot, slot_config.width, host.max_freq_khz);

    card = malloc(sizeof(sdmmc_card_t));
    ESP_RETURN_ON_FALSE(card != NULL, ESP_ERR_NO_MEM, TAG, "no memory for sd card state");

    ESP_LOGI(TAG, "step 1/3: initializing SDMMC host");
    ESP_GOTO_ON_ERROR(host.init(), clean, TAG, "sdmmc host init failed");
    host_init = true;

    ESP_LOGI(TAG, "step 2/3: initializing SDMMC slot");
    ESP_GOTO_ON_ERROR(sdmmc_host_init_slot(host.slot, &slot_config), clean, TAG, "sdmmc slot init failed");

    ESP_LOGI(TAG, "step 3/3: probing SD card");
    ESP_GOTO_ON_ERROR(sdmmc_card_init(&host, card), clean, TAG, "sdmmc card init failed");

    sdmmc_card_print_info(stdout, card);
    *out_card = card;
    return ESP_OK;

clean:
    if (host_init) {
        if (host.flags & SDMMC_HOST_FLAG_DEINIT_ARG) {
            host.deinit_p(host.slot);
        } else {
            host.deinit();
        }
    }
    free(card);
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 3, 0) && SOC_SDMMC_IO_POWER_EXTERNAL
    if (s_sd_pwr_ctrl_handle) {
        sd_pwr_ctrl_del_on_chip_ldo(s_sd_pwr_ctrl_handle);
        s_sd_pwr_ctrl_handle = NULL;
    }
#endif
    return ret;
}

void app_main(void)
{
    ESP_LOGI(TAG, "initializing SD card for USB MSC");

    tinyusb_msc_storage_config_t storage_cfg = {
        .mount_point = TINYUSB_MSC_STORAGE_MOUNT_USB,
        .fat_fs = {
            .base_path = NULL,
            .config.max_files = 5,
            .format_flags = 0,
        },
    };

    sdmmc_card_t *card = NULL;
    esp_err_t ret = init_sdmmc_card(&card);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "SD card initialization failed: %s (0x%x)", esp_err_to_name(ret), ret);
        ESP_LOGE(TAG, "TinyUSB MSC is not started because there is no initialized SD card backing storage.");
        ESP_LOGE(TAG, "Check SD card power, insertion, CMD/CLK/D0 wiring, and external pull-ups first.");
        return;
    }
    storage_cfg.medium.card = card;
    ESP_LOGI(TAG, "creating TinyUSB MSC SDMMC storage");
    ESP_ERROR_CHECK(tinyusb_msc_new_storage_sdmmc(&storage_cfg, &s_storage_hdl));
    ESP_ERROR_CHECK(tinyusb_msc_set_storage_callback(storage_mount_changed_cb, NULL));

    tinyusb_config_t tusb_cfg = TINYUSB_DEFAULT_CONFIG();
    tusb_cfg.descriptor.device = &s_device_desc;
    tusb_cfg.descriptor.full_speed_config = s_msc_fs_config_desc;
    tusb_cfg.descriptor.string = s_string_desc;
    tusb_cfg.descriptor.string_count = sizeof(s_string_desc) / sizeof(s_string_desc[0]);
#if (TUD_OPT_HIGH_SPEED)
    tusb_cfg.descriptor.high_speed_config = s_msc_hs_config_desc;
    tusb_cfg.descriptor.qualifier = &s_device_qualifier;
#endif

    ESP_LOGI(TAG, "installing TinyUSB driver");
    ESP_ERROR_CHECK(tinyusb_driver_install(&tusb_cfg));

    ESP_LOGI(TAG, "USB MSC ready. Connect the USB OTG 2.0HS port to the PC.");
    ESP_LOGI(TAG, "Windows should detect the SD card as a removable drive.");
}
