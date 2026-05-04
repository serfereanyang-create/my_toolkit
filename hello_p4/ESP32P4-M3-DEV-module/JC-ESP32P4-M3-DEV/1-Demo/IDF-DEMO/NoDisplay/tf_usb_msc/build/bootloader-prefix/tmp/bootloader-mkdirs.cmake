# Distributed under the OSI-approved BSD 3-Clause License.  See accompanying
# file LICENSE.rst or https://cmake.org/licensing for details.

cmake_minimum_required(VERSION ${CMAKE_VERSION}) # this file comes with cmake

# If CMAKE_DISABLE_SOURCE_CHANGES is set to true and the source directory is an
# existing directory in our source tree, calling file(MAKE_DIRECTORY) on it
# would cause a fatal error, even though it would be a no-op.
if(NOT EXISTS "C:/esp/esp-idf-v5.4/components/bootloader/subproject")
  file(MAKE_DIRECTORY "C:/esp/esp-idf-v5.4/components/bootloader/subproject")
endif()
file(MAKE_DIRECTORY
  "D:/codex/my_toolkit/hello_p4/ESP32P4-M3-DEV-module/JC-ESP32P4-M3-DEV/1-Demo/IDF-DEMO/NoDisplay/tf_usb_msc/build/bootloader"
  "D:/codex/my_toolkit/hello_p4/ESP32P4-M3-DEV-module/JC-ESP32P4-M3-DEV/1-Demo/IDF-DEMO/NoDisplay/tf_usb_msc/build/bootloader-prefix"
  "D:/codex/my_toolkit/hello_p4/ESP32P4-M3-DEV-module/JC-ESP32P4-M3-DEV/1-Demo/IDF-DEMO/NoDisplay/tf_usb_msc/build/bootloader-prefix/tmp"
  "D:/codex/my_toolkit/hello_p4/ESP32P4-M3-DEV-module/JC-ESP32P4-M3-DEV/1-Demo/IDF-DEMO/NoDisplay/tf_usb_msc/build/bootloader-prefix/src/bootloader-stamp"
  "D:/codex/my_toolkit/hello_p4/ESP32P4-M3-DEV-module/JC-ESP32P4-M3-DEV/1-Demo/IDF-DEMO/NoDisplay/tf_usb_msc/build/bootloader-prefix/src"
  "D:/codex/my_toolkit/hello_p4/ESP32P4-M3-DEV-module/JC-ESP32P4-M3-DEV/1-Demo/IDF-DEMO/NoDisplay/tf_usb_msc/build/bootloader-prefix/src/bootloader-stamp"
)

set(configSubDirs )
foreach(subDir IN LISTS configSubDirs)
    file(MAKE_DIRECTORY "D:/codex/my_toolkit/hello_p4/ESP32P4-M3-DEV-module/JC-ESP32P4-M3-DEV/1-Demo/IDF-DEMO/NoDisplay/tf_usb_msc/build/bootloader-prefix/src/bootloader-stamp/${subDir}")
endforeach()
if(cfgdir)
  file(MAKE_DIRECTORY "D:/codex/my_toolkit/hello_p4/ESP32P4-M3-DEV-module/JC-ESP32P4-M3-DEV/1-Demo/IDF-DEMO/NoDisplay/tf_usb_msc/build/bootloader-prefix/src/bootloader-stamp${cfgdir}") # cfgdir has leading slash
endif()
