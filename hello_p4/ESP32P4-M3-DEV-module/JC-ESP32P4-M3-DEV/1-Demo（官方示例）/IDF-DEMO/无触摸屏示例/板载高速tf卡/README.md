# ESP32-P4 TF USB MSC Demo

这个工程的作用是把插在 ESP32-P4 开发板上的 TF 卡，通过板子的高速 USB 口暴露给电脑，电脑侧会把它识别成一个 U 盘设备。

工程目录：

`D:\codex\my_toolkit\hello_p4\ESP32P4-M3-DEV-module\JC-ESP32P4-M3-DEV\1-Demo\IDF-DEMO\NoDisplay\板载高速tf卡`

## TF 卡可以保存什么数据

就这个工程当前实现来说，TF 卡不是拿来保存“固件本体”的，而是作为一块普通文件存储空间使用。

也就是说，它可以保存几乎所有普通文件，只要文件系统能识别即可，例如：

- 文本文件：`.txt`、`.csv`、`.json`
- 图片文件：`.jpg`、`.png`、`.bmp`
- 音频文件：`.wav`、`.mp3`
- 视频文件：常见媒体文件
- 配置文件、日志文件、用户数据文件
- 传感器采样数据、AI 推理输入输出结果、缓存文件

按当前这份代码来看：

- 程序会在卡里自动尝试创建一个 `README.TXT`
- 其余文件本身没有格式限制
- 电脑把它识别成 U 盘后，你可以像普通 TF 卡/U 盘一样复制、删除、读取文件

注意：

- 当前工程主要完成“挂载 TF 卡 + 通过 USB 暴露给电脑”
- 它没有在代码里限制只能保存某一种业务数据
- 真正保存什么，取决于后续你自己的应用程序往卡里写什么

## 32GB 还是 64GB

从用途上说：

- `32GB` 更稳妥，优先推荐
- `64GB` 可以用，但更依赖卡的格式和兼容性

原因是当前工程使用的是 FAT 文件系统挂载 TF 卡。实际使用里：

- `32GB` 卡通常更容易直接格式化成 `FAT32`
- `64GB` 卡出厂很多是 `exFAT`
- 如果板子侧或当前配置对 `exFAT` 兼容不好，就可能出现“电脑识别到 USB 设备，但没有正常出现盘符/无法访问”

建议：

- 如果你现在的目标是先稳定跑通这个 demo，优先用 `32GB FAT32`
- 如果要用 `64GB`，建议先确认它已经被格式化成板子当前能稳定识别的格式

对这个工程的实际建议排序：

1. 首选 `32GB FAT32`
2. 其次是 `16GB FAT32`
3. `64GB` 只有在你确认格式和兼容性没问题时再用

## 1. 准备工作

- 开发板插好 TF 卡
- TF 卡建议先在 Windows 下格式化为 `FAT32`
- 下载口连接到电脑，当前示例使用串口 `COM9`
- 另外准备一根数据线接开发板的 `High speed USB` / `USB3` 口给电脑做 U 盘识别

注意：

- 烧录固件用的是下载/串口口
- 电脑识别 TF 卡用的是板子的高速 USB 口
- 这两个口不要混淆

## 2. 烧录固件

在 PowerShell 里进入工程目录：

```powershell
cd "D:\codex\my_toolkit\hello_p4\ESP32P4-M3-DEV-module\JC-ESP32P4-M3-DEV\1-Demo\IDF-DEMO\NoDisplay\板载高速tf卡"
```

如果本机默认 `export.bat` 环境不可用，可以用下面这组命令直接烧录：

```powershell
$env:IDF_PATH='C:\esp\esp-idf-v5.4'
$env:IDF_TOOLS_PATH='D:\codex\.espressif'
$env:PATH='D:\codex\.espressif\python_env\idf5.4_py3.13_env\Scripts;C:\Espressif\tools\tools\riscv32-esp-elf\esp-14.2.0_20260121\riscv32-esp-elf\bin;C:\Espressif\tools\tools\cmake\3.30.2\bin;C:\Espressif\tools\tools\ninja\1.12.1;' + $env:PATH
& 'D:\codex\.espressif\python_env\idf5.4_py3.13_env\Scripts\python.exe' 'C:\esp\esp-idf-v5.4\tools\idf.py' -p COM9 flash
```

如果需要重新完整编译再烧录，可以用：

```powershell
& 'D:\codex\.espressif\python_env\idf5.4_py3.13_env\Scripts\python.exe' 'C:\esp\esp-idf-v5.4\tools\idf.py' -p COM9 build flash
```

烧录成功后会看到类似下面的信息：

```text
Serial port COM9
Chip is ESP32-P4
Hash of data verified.
Hard resetting via RTS pin...
Done
```

## 3. 如何测试是否读取成功

### 方法一：看电脑是否识别成 U 盘

1. 烧录完成后，给开发板上电
2. 把高速 USB 口连接到电脑
3. 等待几秒
4. 打开“此电脑”或资源管理器

识别成功时，通常会出现一个新的可移动磁盘。

如果只看到 USB 大容量存储设备，但没有出现盘符，通常表示：

- 板子已经枚举成 USB MSC 设备
- 但 TF 卡没有被正常挂载或没有被正确提供给电脑

工程目录里这两张图可以作为参考：

- `识别为usb设备.png`
- `读取成功.png`

### 方法二：看串口日志

可以在 PowerShell 中读取启动日志：

```powershell
$p = New-Object System.IO.Ports.SerialPort 'COM9',115200,'None',8,'one'
$p.Open()
Start-Sleep -Seconds 10
$data = $p.ReadExisting()
$p.Close()
$data
```

如果 TF 卡和 USB MSC 都工作正常，日志里应该能看到类似关键字：

```text
mounting TF card
TF card mounted at /sdcard
creating TinyUSB MSC storage
USB MSC storage ready
starting USB MSC
ready: connect the High speed USB port to your computer
```

## 4. 常见问题

### 1. 电脑完全没反应

- 检查是不是插错 USB 口
- 必须接高速 USB 口，不是下载串口口
- 换一根支持数据传输的 Type-C 线

### 2. 电脑看到 USB 设备，但没有盘符

- TF 卡可能没有插好
- TF 卡文件系统可能不兼容，优先试 `FAT32`
- 换一张确定正常的 TF 卡测试

### 3. 串口能烧录，但读不到 TF 卡

- 先确认 TF 卡在 Windows 读卡器里本身能正常读写
- 再确认卡容量和格式没有异常

## 5. 关键源码

主逻辑文件：

`main\tf_usb_msc.c`

里面包含：

- TF 卡挂载
- TinyUSB MSC 存储创建
- USB MSC 启动
