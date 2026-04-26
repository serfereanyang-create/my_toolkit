#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <math.h>

// ================== 引脚定义 ==================
#define TFT_CS     5
#define TFT_DC     4
#define TFT_RST    3
#define TFT_MOSI   2
#define TFT_SCLK   1
#define TFT_BLK   20

Adafruit_ST7735 tft = Adafruit_ST7735(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);

// ================== 屏幕参数 ==================
#define SCREEN_W  128
#define SCREEN_H  160
#define CX        64
#define CY        80
#define RADIUS    50

// ================== 纹理参数 ==================
#define TEX_W 64
#define TEX_H 32
uint8_t texture[TEX_H][TEX_W];

// 帧缓冲
uint16_t frameBuffer[SCREEN_W * SCREEN_H];

// 旋转参数（调快）
float rotation = 0;
const float ROT_SPEED = 0.15;

// ================== 颜色定义 ==================
#define C_OCEAN    0x0C3F
#define C_LAND     0x2580
#define C_COAST    0xFFE0
#define C_POLE     0xBDF7
#define C_ATMOS    0x0410
#define C_BLACK    0x0000

// ================== 调试模式 ==================
#define TEST_MODE 0  // 设为1先跑彩虹测试，确认屏幕正常后改0

void setup() {
  Serial.begin(115200);
  delay(500);
  
  // 背光
  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);
  
  // 初始化屏幕
  tft.initR(INITR_BLACKTAB);
  tft.setRotation(0);
  tft.fillScreen(C_BLACK);
  
  Serial.println("屏幕初始化完成");
  
  // 测试模式：验证硬件
  if (TEST_MODE) {
    testScreen();
    while(1);  // 停在这里看效果
  }
  
  // 生成地球纹理
  generateTexture();
  
  Serial.println("纹理生成完成，进入主循环");
}

void loop() {
  // 清空帧缓冲
  clearBuffer();
  
  // 绘制地球
  drawEarth(rotation);
  
  // 大气光晕
  drawAtmosphere();
  
  // 推送帧缓冲到屏幕
  pushBuffer();
  
  // 更新旋转
  rotation += ROT_SPEED;
  if (rotation >= TWO_PI) rotation -= TWO_PI;
  
  delay(25);  // ~40fps
}

// ================== 屏幕测试 ==================
void testScreen() {
  Serial.println("运行屏幕测试...");
  
  // 测试1：全屏红
  tft.fillScreen(ST77XX_RED);
  delay(800);
  
  // 测试2：全屏绿
  tft.fillScreen(ST77XX_GREEN);
  delay(800);
  
  // 测试3：全屏蓝
  tft.fillScreen(ST77XX_BLUE);
  delay(800);
  
  // 测试4：画圆
  tft.fillScreen(C_BLACK);
  tft.drawCircle(CX, CY, 40, ST77XX_WHITE);
  tft.drawCircle(CX, CY, 30, ST77XX_YELLOW);
  tft.drawCircle(CX, CY, 20, ST77XX_CYAN);
  delay(2000);
  
  // 测试5：彩虹渐变（验证帧缓冲推送）
  for (int y = 0; y < SCREEN_H; y++) {
    uint16_t c = tft.color565(y * 2, 255 - y, y);
    for (int x = 0; x < SCREEN_W; x++) {
      frameBuffer[y * SCREEN_W + x] = c;
    }
  }
  pushBuffer();
  delay(2000);
  
  Serial.println("测试完成，把 TEST_MODE 改 0 再上传");
}

// ================== 缓冲操作 ==================
void clearBuffer() {
  memset(frameBuffer, 0, sizeof(frameBuffer));
}

void pushBuffer() {
  // 标准 drawPixel 方式，兼容性最好
  for (int y = 0; y < SCREEN_H; y++) {
    for (int x = 0; x < SCREEN_W; x++) {
      uint16_t c = frameBuffer[y * SCREEN_W + x];
      if (c != C_BLACK) {  // 只画非黑像素，略微加速
        tft.drawPixel(x, y, c);
      }
    }
  }
}

// ================== 地球绘制 ==================
void drawEarth(float angle) {
  float cosA = cos(angle);
  float sinA = sin(angle);
  
  for (int xScreen = 0; xScreen < SCREEN_W; xScreen++) {
    int x = xScreen - CX;
    
    // 跳过球外区域
    if (x < -RADIUS || x > RADIUS) continue;
    
    int yMax = (int)sqrt((float)(RADIUS*RADIUS - x*x));
    
    for (int y = -yMax; y <= yMax; y++) {
      int yScreen = CY + y;
      if (yScreen < 0 || yScreen >= SCREEN_H) continue;
      
      // 3D球面坐标
      float x3d = (float)x;
      float y3d = (float)y;
      float z3d = sqrt((float)(RADIUS*RADIUS - x*x - y*y));
      
      // 绕Y轴旋转
      float xRot = x3d * cosA + z3d * sinA;   // 注意：这里改了符号
      float zRot = -x3d * sinA + z3d * cosA;  // 标准旋转矩阵
      
      // 纹理映射（用旋转后的坐标，不剔除背面，让球完整）
      // 或者：if (zRot < -5) continue;  // 宽松剔除
      
      // 法向量用于光照
      float nx = xRot / RADIUS;
      float ny = y3d / RADIUS;
      float nz = zRot / RADIUS;
      
      // 纹理坐标
      float u = atan2(xRot, zRot);
      float v = asin(ny);
      
      int texU = (int)((u + PI) / TWO_PI * TEX_W);
      texU = ((texU % TEX_W) + TEX_W) % TEX_W;  // 正确取模
      
      int texV = (int)((v + PI/2) / PI * TEX_H);
      if (texV < 0) texV = 0;
      if (texV >= TEX_H) texV = TEX_H - 1;
      
      // 获取纹理颜色
      uint8_t texel = texture[texV][texU];
      uint16_t color;
      
      switch(texel) {
        case 1: color = C_LAND; break;
        case 2: color = C_POLE; break;
        case 3: color = C_COAST; break;
        default: color = C_OCEAN; break;
      }
      
      // 光照：面向观察者越正越亮
      float light = 0.3 + 0.7 * nz;
      if (light < 0.3) light = 0.3;
      if (light > 1.0) light = 1.0;
      
      color = adjustBrightness(color, light);
      
      // 边缘大气
      float dist = sqrt((float)(x*x + y*y)) / RADIUS;
      if (dist > 0.8) {
        float t = (dist - 0.8) * 5.0;
        if (t > 1.0) t = 1.0;
        color = blendColor(color, C_ATMOS, t * 0.5);
      }
      
      frameBuffer[yScreen * SCREEN_W + xScreen] = color;
    }
  }
}

// ================== 大气光晕 ==================
void drawAtmosphere() {
  for (int xScreen = 0; xScreen < SCREEN_W; xScreen++) {
    int x = xScreen - CX;
    for (int yScreen = 0; yScreen < SCREEN_H; yScreen++) {
      int y = yScreen - CY;
      
      float dist = sqrt((float)(x*x + y*y));
      if (dist <= RADIUS || dist >= RADIUS + 6) continue;
      
      float glow = 1.0 - (dist - RADIUS) / 6.0;
      glow = glow * glow;
      
      int idx = yScreen * SCREEN_W + xScreen;
      if (frameBuffer[idx] == C_BLACK) {
        frameBuffer[idx] = blendColor(C_BLACK, C_ATMOS, glow * 0.3);
      }
    }
  }
}

// ================== 纹理生成 ==================
void generateTexture() {
  // 清零
  for (int v = 0; v < TEX_H; v++) {
    for (int u = 0; u < TEX_W; u++) {
      texture[v][u] = 0;
    }
  }
  
  for (int v = 0; v < TEX_H; v++) {
    for (int u = 0; u < TEX_W; u++) {
      float lat = (v / (float)TEX_H - 0.5f) * PI;
      float lon = (u / (float)TEX_W) * TWO_PI - PI;
      
      float land = 0;
      // 欧亚非
      land += ellipse(lon, lat, 0.5f, 0.1f, 1.2f, 0.5f);
      // 美洲
      land += ellipse(lon, lat, -1.6f, 0.0f, 0.35f, 0.7f);
      // 澳洲
      land += ellipse(lon, lat, 2.2f, -0.4f, 0.25f, 0.2f);
      // 南极
      if (lat < -1.0f) land += 0.8f;
      // 北极
      if (lat > 1.1f) land += 0.3f;
      
      if (v < 2 || v >= TEX_H - 2) {
        texture[v][u] = 2;
      } else if (land > 0.5f && land < 0.7f) {
        texture[v][u] = 3;
      } else if (land > 0.5f) {
        texture[v][u] = 1;
      }
    }
  }
}

float ellipse(float lon, float lat, float cx, float cy, float rx, float ry) {
  float dx = (lon - cx) / rx;
  float dy = (lat - cy) / ry;
  return 1.0f / (1.0f + dx*dx + dy*dy);
}

// ================== 颜色工具 ==================
uint16_t adjustBrightness(uint16_t color, float factor) {
  if (factor > 1.0f) factor = 1.0f;
  if (factor < 0.0f) factor = 0.0f;
  
  uint8_t r = (color >> 11) & 0x1F;
  uint8_t g = (color >> 5) & 0x3F;
  uint8_t b = color & 0x1F;
  
  r = (uint8_t)(r * factor);
  g = (uint8_t)(g * factor);
  b = (uint8_t)(b * factor);
  
  return (r << 11) | (g << 5) | b;
}

uint16_t blendColor(uint16_t c1, uint16_t c2, float t) {
  if (t < 0.0f) t = 0.0f;
  if (t > 1.0f) t = 1.0f;
  
  uint8_t r1 = (c1 >> 11) & 0x1F;
  uint8_t g1 = (c1 >> 5) & 0x3F;
  uint8_t b1 = c1 & 0x1F;
  
  uint8_t r2 = (c2 >> 11) & 0x1F;
  uint8_t g2 = (c2 >> 5) & 0x3F;
  uint8_t b2 = c2 & 0x1F;
  
  uint8_t r = (uint8_t)(r1 * (1.0f - t) + r2 * t);
  uint8_t g = (uint8_t)(g1 * (1.0f - t) + g2 * t);
  uint8_t b = (uint8_t)(b1 * (1.0f - t) + b2 * t);
  
  return (r << 11) | (g << 5) | b;
}