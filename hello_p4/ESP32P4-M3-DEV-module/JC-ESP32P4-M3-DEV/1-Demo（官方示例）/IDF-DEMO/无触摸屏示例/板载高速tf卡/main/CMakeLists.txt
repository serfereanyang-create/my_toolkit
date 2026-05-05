idf_component_register(
    SRCS "tf_usb_msc.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES fatfs console esp32_p4_function_ev_board
)
