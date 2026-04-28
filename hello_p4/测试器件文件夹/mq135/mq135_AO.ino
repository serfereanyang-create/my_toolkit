#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_adc/adc_oneshot.h"


static adc_oneshot_unit_handle_t adc_handle;

void app_main(void)
{
    printf("===== MQ135 AO Test on GPIO4 =====\n");

    adc_oneshot_unit_init_cfg_t init_cfg = {.unit_id = ADC_UNIT_1};
    adc_oneshot_new_unit(&init_cfg, &adc_handle);

    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    adc_oneshot_config_channel(adc_handle, ADC_CHANNEL_4, &chan_cfg);  // GPIO4

    while(1) {
        int raw = 0;
        adc_oneshot_read(adc_handle, ADC_CHANNEL_4, &raw);
        printf("AO Raw: %4d\n", raw);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

