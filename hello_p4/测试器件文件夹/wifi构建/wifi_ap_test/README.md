# ESP32-P4 WiFi AP Test

这个 Arduino 示例会让 ESP32-P4 自己发出一个 WiFi 热点。

热点信息：

- SSID: `ESP32P4_TEST`
- Password: `12345678`

建议 Arduino IDE 配置：

- 开发板：`ESP32P4 Dev Module`
- Arduino 核心版本：`arduino_esp32_v3.2.1`
- Flash Frequency：`80MHz`
- Flash Mode：`QIO`
- Flash Size：`16MB`
- PSRAM：`Enabled`
- Upload Mode：`UART0 / Hardware CDC`
- 串口：选择开发板对应端口，例如 `COM9`
- 串口监视器波特率：`115200`

上传成功后：

1. 按一下开发板 `RST`
2. 手机或电脑搜索 WiFi：`ESP32P4_TEST`
3. 连接密码：`12345678`
4. 串口监视器会打印 AP IP 和当前连接设备数量
