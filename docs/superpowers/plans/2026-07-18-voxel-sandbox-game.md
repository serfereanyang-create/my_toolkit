# 原创像素体素沙盒游戏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立的 `voxel-game/` 子项目中交付一个可在桌面浏览器游玩的原创像素体素创造模式游戏，具备三个程序化维度、区块流式加载、第一人称建造和本地存档。

**Architecture:** TypeScript 领域模块负责方块、世界生成、区块网格、物理和存档；Web Worker 负责昂贵的区块生成与构网；Three.js 主线程负责渲染；原生 DOM 负责 HUD 和菜单。纯算法与浏览器适配层分离，以便 Vitest 测试确定性生成、碰撞、射线和存档，Playwright 验证真实浏览器主流程。

**Tech Stack:** TypeScript, Vite, Three.js, IndexedDB (`idb`), Vitest, Playwright, Web Workers, Web Audio API, HTML/CSS

**Design reference:** `docs/superpowers/specs/2026-07-18-voxel-sandbox-game-design.md`

**Repository note:** `C:\Users\34516\ZCodeProject` 不是 Git 仓库。Task 1 将只在新建的 `voxel-game/` 中初始化独立 Git 仓库，不改动现有科研论文应用。

---

## 文件结构与职责

```text
voxel-game/
├── .gitignore                         # 忽略依赖、构建产物和测试报告
├── README.md                          # 运行、控制、兼容性、原创资产声明
├── index.html                         # 唯一页面入口与可访问性元信息
├── package.json                       # 开发、测试、构建和预览脚本
├── tsconfig.json                      # 浏览器与 Worker 严格 TypeScript 配置
├── vite.config.ts                     # Vite 开发与生产构建
├── vitest.config.ts                   # jsdom/Node 单元测试配置
├── playwright.config.ts               # Chromium 冒烟测试配置
├── src/
│   ├── main.ts                        # 创建 GameApp；顶层错误兜底
│   ├── styles.css                     # 画布、HUD、菜单、加载和响应式样式
│   ├── types.ts                       # WorldId、向量、设置、玩家快照等共享类型
│   ├── app/
│   │   ├── GameApp.ts                 # 顶层状态机与子系统生命周期
│   │   └── GameClock.ts               # 固定物理步与可变渲染步
│   ├── engine/
│   │   ├── Renderer.ts                # Three.js 场景、相机、光照、雾和区块 Mesh
│   │   ├── InputManager.ts            # 键鼠、指针锁定、失焦清键
│   │   └── ChunkScheduler.ts          # 视距集合、优先级和每帧上传预算
│   ├── world/
│   │   ├── blocks.ts                  # 方块 ID、属性和纹理面映射
│   │   ├── coordinates.ts             # 负坐标安全的世界/区块/局部换算
│   │   ├── Chunk.ts                   # 紧凑 Uint8Array 区块数据
│   │   ├── ChunkStore.ts              # 分维度区块状态和增量编辑
│   │   ├── World.ts                   # 方块查询/修改、加载队列和脏网格事件
│   │   ├── noise.ts                   # 确定性哈希、2D/3D 平滑值噪声与 FBM
│   │   ├── generators.ts              # 青原界、赤核界、云屿界和安全出生点
│   │   ├── meshing.ts                 # 不透明贪心网格与透明可见面网格
│   │   └── workerProtocol.ts           # Worker 请求/响应判别联合类型
│   ├── workers/
│   │   └── world.worker.ts            # 生成体素、叠加增量并构建可传输网格
│   ├── player/
│   │   ├── PlayerPhysics.ts           # AABB、重力、跳跃、冲刺和飞行碰撞
│   │   ├── VoxelRaycast.ts            # 体素 DDA 命中坐标与面法线
│   │   └── PlayerController.ts        # 输入意图、相机姿态和破坏/放置请求
│   ├── textures/
│   │   └── TextureAtlas.ts            # 运行时原创 16×16 像素纹理图集
│   ├── persistence/
│   │   ├── saveTypes.ts               # IndexedDB schema 与版本化 DTO
│   │   └── SaveRepository.ts          # 存档、迁移、降级和防抖刷盘
│   ├── audio/
│   │   └── SoundSynth.ts              # 原创 Web Audio 程序音效
│   └── ui/
│       ├── Hud.ts                     # 准星、状态、性能和通知
│       ├── Hotbar.ts                  # 九格快捷栏与滚轮/数字键选择
│       ├── BlockPicker.ts             # 创造模式方块选择面板
│       └── PauseMenu.ts               # 暂停、维度、设置与重置确认
└── tests/
    ├── unit/                           # 与 src 模块一一对应的 Vitest 测试
    └── e2e/game.spec.ts               # 真实浏览器启动、建造、存档和切维度
```

核心共享接口在 Task 2 固定，后续任务不得另造同义类型：

```ts
export type WorldId = 'overworld' | 'ember' | 'skylands';
export interface Vec3 { x: number; y: number; z: number }
export interface ChunkCoord { x: number; z: number }
export interface LocalBlockCoord { x: number; y: number; z: number }
export interface BlockEdit extends LocalBlockCoord { block: BlockId }
export interface PlayerSnapshot {
  worldId: WorldId;
  position: Vec3;
  yaw: number;
  pitch: number;
  flying: boolean;
  selectedSlot: number;
}
```

---

### Task 1: 初始化独立工程与可运行标题界面

**Files:**
- Create: `voxel-game/.gitignore`
- Create: `voxel-game/package.json`
- Create: `voxel-game/tsconfig.json`
- Create: `voxel-game/vite.config.ts`
- Create: `voxel-game/vitest.config.ts`
- Create: `voxel-game/playwright.config.ts`
- Create: `voxel-game/index.html`
- Create: `voxel-game/src/main.ts`
- Create: `voxel-game/src/styles.css`
- Create: `voxel-game/src/app/GameApp.ts`
- Create: `voxel-game/tests/unit/GameApp.test.ts`

- [ ] **Step 1: 创建目录、初始化嵌套仓库并安装依赖**

Run from `C:\Users\34516\ZCodeProject`:

```bash
mkdir -p voxel-game/src/app voxel-game/tests/unit voxel-game/tests/e2e
cd voxel-game
git init
npm init -y
npm install three idb
npm install -D vite typescript vitest jsdom @vitest/coverage-v8 @types/three @playwright/test
npm pkg set type=module scripts.dev="vite" scripts.build="tsc --noEmit && vite build" scripts.test="vitest run" scripts.test:watch="vitest" scripts.test:e2e="playwright test" scripts.preview="vite preview"
```

Expected: npm exits `0`; only `voxel-game/.git` is created.

- [ ] **Step 2: 写入严格构建与测试配置**

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
playwright-report/
test-results/
.DS_Store
*.log
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": false,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src", "tests", "*.config.ts"]
}
```

Create `vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 4173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'], include: ['src/**/*.ts'] },
  },
});
```

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
  },
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4173' },
});
```

- [ ] **Step 3: 先写标题界面失败测试**

Create `tests/unit/GameApp.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { GameApp } from '../../src/app/GameApp';

describe('GameApp', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('mounts an accessible title screen', () => {
    const app = new GameApp(document.body);
    app.mount();
    expect(document.querySelector('h1')?.textContent).toBe('方境');
    expect(document.querySelector<HTMLButtonElement>('[data-action="enter"]')?.disabled).toBe(false);
    app.destroy();
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npm test -- GameApp.test.ts`

Expected: FAIL because `src/app/GameApp.ts` does not exist.

- [ ] **Step 5: 实现最小标题状态**

Create `src/app/GameApp.ts`:

```ts
export class GameApp {
  private root: HTMLElement | null = null;

  constructor(private readonly host: HTMLElement) {}

  mount(): void {
    this.host.innerHTML = `
      <main class="app-shell" data-state="ready">
        <section class="title-panel" aria-labelledby="game-title">
          <p class="eyebrow">原创像素体素沙盒</p>
          <h1 id="game-title">方境</h1>
          <p>探索三个程序化世界，自由破坏与建造。</p>
          <button type="button" data-action="enter">进入世界</button>
        </section>
      </main>`;
    this.root = this.host.firstElementChild as HTMLElement;
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
  }
}
```

Create `src/main.ts`:

```ts
import './styles.css';
import { GameApp } from './app/GameApp';

const app = new GameApp(document.body);
app.mount();
```

Create `index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#86c96f" />
    <title>方境 · 原创像素体素沙盒</title>
  </head>
  <body><script type="module" src="/src/main.ts"></script></body>
</html>
```

Create `src/styles.css` with the complete initial shell:

```css
:root { color: #f7f3df; background: #101820; font-family: ui-monospace, "Cascadia Mono", monospace; }
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
button { font: inherit; }
.app-shell { min-height: 100%; display: grid; place-items: center; background: linear-gradient(#78b9d6 0 55%, #6fa75e 55%); image-rendering: pixelated; }
.title-panel { width: min(92vw, 34rem); padding: 2rem; border: 4px solid #26382b; color: #172218; background: rgba(247, 243, 223, .92); box-shadow: 12px 12px 0 rgba(21, 31, 23, .35); text-align: center; }
.title-panel h1 { margin: .25rem 0; font-size: clamp(3rem, 10vw, 6rem); letter-spacing: .12em; }
.eyebrow { font-weight: 700; letter-spacing: .15em; }
button { min-height: 44px; padding: .7rem 1.2rem; border: 3px solid #213021; color: #fff; background: #3f713f; box-shadow: 0 4px 0 #213021; cursor: pointer; }
button:hover { background: #4d854d; }
button:focus-visible { outline: 4px solid #ffe27a; outline-offset: 3px; }
```

- [ ] **Step 6: 验证最小工程**

Run: `npm test && npm run build`

Expected: one passing test and a successful Vite production build.

- [ ] **Step 7: 提交**

```bash
git add .
git commit -m "chore: scaffold voxel game"
```

---

### Task 2: 固定共享类型、方块注册表与坐标换算

**Files:**
- Create: `voxel-game/src/types.ts`
- Create: `voxel-game/src/world/blocks.ts`
- Create: `voxel-game/src/world/coordinates.ts`
- Create: `voxel-game/tests/unit/coordinates.test.ts`
- Create: `voxel-game/tests/unit/blocks.test.ts`

- [ ] **Step 1: 写坐标和方块失败测试**

Create `tests/unit/coordinates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chunkKey, worldToChunk } from '../../src/world/coordinates';

describe('worldToChunk', () => {
  it.each([
    [0, 0, 0, 0], [15, 0, 0, 15], [16, 1, 0, 0],
    [-1, -1, 0, 15], [-16, -1, 0, 0], [-17, -2, 0, 15],
  ])('maps x=%i to chunk=%i z=%i local=%i', (x, chunkX, chunkZ, localX) => {
    expect(worldToChunk(x, 0)).toEqual({ chunkX, chunkZ, localX, localZ: 0 });
  });

  it('includes the dimension in chunk keys', () => {
    expect(chunkKey('ember', -2, 4)).toBe('ember:-2:4');
  });
});
```

Create `tests/unit/blocks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BLOCKS, BlockId, isCollidable, isOpaque } from '../../src/world/blocks';

describe('block registry', () => {
  it('contains a definition for every block id', () => {
    for (let id = BlockId.Air; id <= BlockId.GlowCrystal; id += 1) {
      expect(BLOCKS[id]).toBeDefined();
    }
  });

  it('treats water and lava as non-collidable transparent blocks', () => {
    expect(isOpaque(BlockId.Water)).toBe(false);
    expect(isCollidable(BlockId.Water)).toBe(false);
    expect(isCollidable(BlockId.Lava)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- coordinates.test.ts blocks.test.ts`

Expected: FAIL with unresolved module errors.

- [ ] **Step 3: 实现统一类型和负坐标安全换算**

Create `src/types.ts`:

```ts
import type { BlockId } from './world/blocks';

export type WorldId = 'overworld' | 'ember' | 'skylands';
export interface Vec3 { x: number; y: number; z: number }
export interface ChunkCoord { x: number; z: number }
export interface LocalBlockCoord { x: number; y: number; z: number }
export interface BlockEdit extends LocalBlockCoord { block: BlockId }
export interface PlayerSnapshot {
  worldId: WorldId;
  position: Vec3;
  yaw: number;
  pitch: number;
  flying: boolean;
  selectedSlot: number;
}
export interface GameSettings {
  mouseSensitivity: number;
  viewDistance: number;
  masterVolume: number;
  quality: 'low' | 'high';
  showDebug: boolean;
}
```

Create `src/world/coordinates.ts`:

```ts
import type { WorldId } from '../types';

export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 96;

export function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

export function positiveMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export function worldToChunk(x: number, z: number) {
  return {
    chunkX: floorDiv(x, CHUNK_SIZE),
    chunkZ: floorDiv(z, CHUNK_SIZE),
    localX: positiveMod(x, CHUNK_SIZE),
    localZ: positiveMod(z, CHUNK_SIZE),
  };
}

export function chunkKey(worldId: WorldId, chunkX: number, chunkZ: number): string {
  return `${worldId}:${chunkX}:${chunkZ}`;
}
```

- [ ] **Step 4: 实现原创方块注册表**

Create `src/world/blocks.ts`:

```ts
export enum BlockId {
  Air, Grass, Dirt, Stone, Sand, Snow, Log, Leaves, Planks,
  Glass, Water, EmberRock, AshStone, Lava, CloudStone, MossGrass, GlowCrystal,
}

export type TextureName =
  | 'grassTop' | 'grassSide' | 'dirt' | 'stone' | 'sand' | 'snow'
  | 'logTop' | 'logSide' | 'leaves' | 'planks' | 'glass' | 'water'
  | 'emberRock' | 'ashStone' | 'lava' | 'cloudStone' | 'mossGrass' | 'glowCrystal';

export interface BlockDefinition {
  id: BlockId;
  name: string;
  opaque: boolean;
  collidable: boolean;
  liquid: boolean;
  emissive: boolean;
  textures: { top: TextureName; side: TextureName; bottom: TextureName };
}

const all = (name: TextureName) => ({ top: name, side: name, bottom: name });

export const BLOCKS: Readonly<Record<BlockId, BlockDefinition>> = {
  [BlockId.Air]: { id: BlockId.Air, name: '空气', opaque: false, collidable: false, liquid: false, emissive: false, textures: all('glass') },
  [BlockId.Grass]: { id: BlockId.Grass, name: '青草方块', opaque: true, collidable: true, liquid: false, emissive: false, textures: { top: 'grassTop', side: 'grassSide', bottom: 'dirt' } },
  [BlockId.Dirt]: { id: BlockId.Dirt, name: '泥土', opaque: true, collidable: true, liquid: false, emissive: false, textures: all('dirt') },
  [BlockId.Stone]: { id: BlockId.Stone, name: '岩石', opaque: true, collidable: true, liquid: false, emissive: false, textures: all('stone') },
  [BlockId.Sand]: { id: BlockId.Sand, name: '砂', opaque: true, collidable: true, liquid: false, emissive: false, textures: all('sand') },
  [BlockId.Snow]: { id: BlockId.Snow, name: '雪块', opaque: true, collidable: true, liquid: false, emissive: false, textures: all('snow') },
  [BlockId.Log]: { id: BlockId.Log, name: '风木原木', opaque: true, collidable: true, liquid: false, emissive: false, textures: { top: 'logTop', side: 'logSide', bottom: 'logTop' } },
  [BlockId.Leaves]: { id: BlockId.Leaves, name: '树叶', opaque: false, collidable: true, liquid: false, emissive: false, textures: all('leaves') },
  [BlockId.Planks]: { id: BlockId.Planks, name: '木板', opaque: true, collidable: true, liquid: false, emissive: false, textures: all('planks') },
  [BlockId.Glass]: { id: BlockId.Glass, name: '玻璃', opaque: false, collidable: true, liquid: false, emissive: false, textures: all('glass') },
  [BlockId.Water]: { id: BlockId.Water, name: '水', opaque: false, collidable: false, liquid: true, emissive: false, textures: all('water') },
  [BlockId.EmberRock]: { id: BlockId.EmberRock, name: '赤岩', opaque: true, collidable: true, liquid: false, emissive: false, textures: all('emberRock') },
  [BlockId.AshStone]: { id: BlockId.AshStone, name: '灰岩', opaque: true, collidable: true, liquid: false, emissive: false, textures: all('ashStone') },
  [BlockId.Lava]: { id: BlockId.Lava, name: '熔岩', opaque: false, collidable: false, liquid: true, emissive: true, textures: all('lava') },
  [BlockId.CloudStone]: { id: BlockId.CloudStone, name: '云石', opaque: true, collidable: true, liquid: false, emissive: false, textures: all('cloudStone') },
  [BlockId.MossGrass]: { id: BlockId.MossGrass, name: '苔草', opaque: true, collidable: true, liquid: false, emissive: false, textures: all('mossGrass') },
  [BlockId.GlowCrystal]: { id: BlockId.GlowCrystal, name: '辉晶', opaque: false, collidable: true, liquid: false, emissive: true, textures: all('glowCrystal') },
};

export const isOpaque = (id: BlockId): boolean => BLOCKS[id].opaque;
export const isCollidable = (id: BlockId): boolean => BLOCKS[id].collidable;
```

- [ ] **Step 5: 验证并提交**

Run: `npm test -- coordinates.test.ts blocks.test.ts && npm run build`

Expected: all tests PASS and TypeScript reports no errors.

```bash
git add src/types.ts src/world tests/unit
git commit -m "feat: define blocks and chunk coordinates"
```

---

### Task 3: 实现紧凑区块、确定性噪声和三个维度生成

**Files:**
- Create: `voxel-game/src/world/Chunk.ts`
- Create: `voxel-game/src/world/noise.ts`
- Create: `voxel-game/src/world/generators.ts`
- Create: `voxel-game/tests/unit/Chunk.test.ts`
- Create: `voxel-game/tests/unit/generators.test.ts`

- [ ] **Step 1: 写区块和生成器失败测试**

Create `tests/unit/Chunk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BlockId } from '../../src/world/blocks';
import { Chunk } from '../../src/world/Chunk';
import { CHUNK_HEIGHT, CHUNK_SIZE } from '../../src/world/coordinates';

describe('Chunk', () => {
  it('stores one byte per block and addresses every axis', () => {
    const chunk = new Chunk('overworld', -1, 2);
    expect(chunk.blocks.byteLength).toBe(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
    chunk.set(15, 95, 0, BlockId.GlowCrystal);
    expect(chunk.get(15, 95, 0)).toBe(BlockId.GlowCrystal);
  });
});
```

Create `tests/unit/generators.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BlockId } from '../../src/world/blocks';
import { generateChunk, findSafeSpawn } from '../../src/world/generators';
import type { WorldId } from '../../src/types';

const worlds: WorldId[] = ['overworld', 'ember', 'skylands'];

describe('world generation', () => {
  it.each(worlds)('%s is deterministic and contains air plus terrain', (worldId) => {
    const a = generateChunk(worldId, 104729, 0, 0);
    const b = generateChunk(worldId, 104729, 0, 0);
    expect(a.blocks).toEqual(b.blocks);
    expect(a.blocks).toContain(BlockId.Air);
    expect([...a.blocks].some((id) => id !== BlockId.Air)).toBe(true);
  });

  it.each(worlds)('%s returns a safe spawn with two air blocks', (worldId) => {
    const spawn = findSafeSpawn(worldId, 104729);
    expect(spawn.y).toBeGreaterThan(1);
    const chunk = generateChunk(worldId, 104729, Math.floor(spawn.x / 16), Math.floor(spawn.z / 16));
    const lx = ((spawn.x % 16) + 16) % 16;
    const lz = ((spawn.z % 16) + 16) % 16;
    expect(chunk.get(lx, spawn.y, lz)).toBe(BlockId.Air);
    expect(chunk.get(lx, spawn.y + 1, lz)).toBe(BlockId.Air);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- Chunk.test.ts generators.test.ts`

Expected: FAIL because `Chunk` and generators are unresolved.

- [ ] **Step 3: 实现区块和确定性噪声原语**

Create `src/world/Chunk.ts`:

```ts
import type { WorldId } from '../types';
import { BlockId } from './blocks';
import { CHUNK_HEIGHT, CHUNK_SIZE } from './coordinates';

export class Chunk {
  readonly blocks: Uint8Array;
  revision = 0;

  constructor(readonly worldId: WorldId, readonly x: number, readonly z: number, blocks?: Uint8Array) {
    const size = CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE;
    if (blocks && blocks.length !== size) throw new RangeError(`Expected ${size} blocks`);
    this.blocks = blocks ?? new Uint8Array(size);
  }

  static index(x: number, y: number, z: number): number {
    return y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x;
  }

  get(x: number, y: number, z: number): BlockId {
    if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT || z < 0 || z >= CHUNK_SIZE) return BlockId.Air;
    return this.blocks[Chunk.index(x, y, z)] as BlockId;
  }

  set(x: number, y: number, z: number, block: BlockId): void {
    if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT || z < 0 || z >= CHUNK_SIZE) throw new RangeError('Block coordinate outside chunk');
    this.blocks[Chunk.index(x, y, z)] = block;
    this.revision += 1;
  }
}
```

Create `src/world/noise.ts` with these exact deterministic exports:

```ts
const fract = (value: number) => value - Math.floor(value);
const smooth = (value: number) => value * value * (3 - 2 * value);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = Math.imul(seed ^ x, 0x45d9f3b);
  h = Math.imul(h ^ y, 0x45d9f3b);
  h = Math.imul(h ^ z, 0x45d9f3b);
  h ^= h >>> 16;
  return fract((h >>> 0) / 0x1_0000_0000);
}

export function noise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x); const iz = Math.floor(z);
  const fx = smooth(x - ix); const fz = smooth(z - iz);
  const a = mix(hash3(seed, ix, 0, iz), hash3(seed, ix + 1, 0, iz), fx);
  const b = mix(hash3(seed, ix, 0, iz + 1), hash3(seed, ix + 1, 0, iz + 1), fx);
  return mix(a, b, fz) * 2 - 1;
}

export function noise3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x); const iy = Math.floor(y); const iz = Math.floor(z);
  const fx = smooth(x - ix); const fy = smooth(y - iy); const fz = smooth(z - iz);
  const plane = (dy: number) => {
    const a = mix(hash3(seed, ix, iy + dy, iz), hash3(seed, ix + 1, iy + dy, iz), fx);
    const b = mix(hash3(seed, ix, iy + dy, iz + 1), hash3(seed, ix + 1, iy + dy, iz + 1), fx);
    return mix(a, b, fz);
  };
  return (mix(plane(0), plane(1), fy) * 2) - 1;
}

export function fbm2(seed: number, x: number, z: number, octaves = 4): number {
  let value = 0; let amplitude = .5; let frequency = 1; let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    value += noise2(seed + octave * 1013, x * frequency, z * frequency) * amplitude;
    total += amplitude; amplitude *= .5; frequency *= 2;
  }
  return value / total;
}
```

- [ ] **Step 4: 实现三个维度的生成规则**

Create `src/world/generators.ts`. Use global coordinates for every decision so adjacent chunks agree. Implement these formulas exactly:

```ts
import type { Vec3, WorldId } from '../types';
import { BlockId } from './blocks';
import { Chunk } from './Chunk';
import { CHUNK_HEIGHT, CHUNK_SIZE, worldToChunk } from './coordinates';
import { fbm2, hash3, noise2, noise3 } from './noise';

const SEA_LEVEL = 31;

function overworldBlock(seed: number, x: number, y: number, z: number): BlockId {
  const continental = fbm2(seed, x / 96, z / 96, 5);
  const detail = fbm2(seed + 17, x / 28, z / 28, 3);
  const height = Math.floor(34 + continental * 17 + detail * 5);
  const temperature = noise2(seed + 31, x / 150, z / 150);
  const humidity = noise2(seed + 47, x / 130, z / 130);
  if (y > height) return y <= SEA_LEVEL ? BlockId.Water : BlockId.Air;
  if (y < height - 4) return BlockId.Stone;
  if (temperature > .38 && humidity < -.08) return BlockId.Sand;
  if (temperature < -.35 && y === height) return BlockId.Snow;
  return y === height ? BlockId.Grass : BlockId.Dirt;
}

function emberBlock(seed: number, x: number, y: number, z: number): BlockId {
  if (y < 7) return y < 4 ? BlockId.Lava : BlockId.EmberRock;
  if (y > 86) return BlockId.EmberRock;
  const cavern = noise3(seed + 101, x / 21, y / 16, z / 21) + noise3(seed + 103, x / 8, y / 9, z / 8) * .25;
  if (cavern > -.08) return BlockId.Air;
  if (hash3(seed + 107, x, y, z) > .997) return BlockId.GlowCrystal;
  return y % 13 === 0 && hash3(seed, x, y, z) > .72 ? BlockId.AshStone : BlockId.EmberRock;
}

function skylandsBlock(seed: number, x: number, y: number, z: number): BlockId {
  const center = 55 + fbm2(seed + 211, x / 80, z / 80, 3) * 15;
  const horizontal = fbm2(seed + 223, x / 42, z / 42, 4);
  const density = horizontal * .95 + noise3(seed + 227, x / 25, y / 17, z / 25) * .28 - Math.abs(y - center) / 17;
  if (density <= .22) return BlockId.Air;
  const aboveDensity = horizontal * .95 + noise3(seed + 227, x / 25, (y + 1) / 17, z / 25) * .28 - Math.abs(y + 1 - center) / 17;
  return aboveDensity <= .22 ? BlockId.MossGrass : BlockId.CloudStone;
}

export function sampleGeneratedBlock(worldId: WorldId, seed: number, x: number, y: number, z: number): BlockId {
  if (y < 0 || y >= CHUNK_HEIGHT) return BlockId.Air;
  if (worldId === 'overworld') return overworldBlock(seed, x, y, z);
  if (worldId === 'ember') return emberBlock(seed, x, y, z);
  return skylandsBlock(seed, x, y, z);
}

export function generateChunk(worldId: WorldId, seed: number, chunkX: number, chunkZ: number): Chunk {
  const chunk = new Chunk(worldId, chunkX, chunkZ);
  for (let y = 0; y < CHUNK_HEIGHT; y += 1) for (let z = 0; z < CHUNK_SIZE; z += 1) for (let x = 0; x < CHUNK_SIZE; x += 1) {
    chunk.blocks[Chunk.index(x, y, z)] = sampleGeneratedBlock(worldId, seed, chunkX * CHUNK_SIZE + x, y, chunkZ * CHUNK_SIZE + z);
  }
  return chunk;
}

export function findSafeSpawn(worldId: WorldId, seed: number): Vec3 {
  for (let radius = 0; radius <= 24; radius += 1) {
    for (let z = -radius; z <= radius; z += 1) for (let x = -radius; x <= radius; x += 1) {
      for (let y = CHUNK_HEIGHT - 3; y >= 1; y -= 1) {
        const floor = sampleGeneratedBlock(worldId, seed, x, y - 1, z);
        if (floor !== BlockId.Air && floor !== BlockId.Water && floor !== BlockId.Lava && sampleGeneratedBlock(worldId, seed, x, y, z) === BlockId.Air && sampleGeneratedBlock(worldId, seed, x, y + 1, z) === BlockId.Air) return { x, y, z };
      }
    }
  }
  return { x: 0, y: worldId === 'skylands' ? 72 : 48, z: 0 };
}

export function chunkContaining(position: Vec3) {
  return worldToChunk(Math.floor(position.x), Math.floor(position.z));
}
```

After the base tests pass, add deterministic decorations in this same file with a second pass: overworld tree candidates occur where `hash3(seed + 59, globalX, 0, globalZ) > .996` on grass with five free blocks; place a four-block `Log` trunk and a radius-two `Leaves` crown. Skylands uses the same cross-chunk global sampling with seed `+239` to place three-block logs and leaf crowns. Decoration lookup must examine candidates within two blocks outside the current chunk so crowns are seamless; writes are clipped to local coordinates.

- [ ] **Step 5: 验证并提交**

Run: `npm test -- Chunk.test.ts generators.test.ts && npm run build`

Expected: deterministic tests PASS for all dimensions.

```bash
git add src/world tests/unit
git commit -m "feat: generate three deterministic voxel dimensions"
```

---

### Task 4: 实现区块存储、跨边界编辑和世界查询

**Files:**
- Create: `voxel-game/src/world/ChunkStore.ts`
- Create: `voxel-game/src/world/World.ts`
- Create: `voxel-game/tests/unit/ChunkStore.test.ts`
- Create: `voxel-game/tests/unit/World.test.ts`

- [ ] **Step 1: 写跨区块读写和边界脏标记测试**

Create `tests/unit/World.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { BlockId } from '../../src/world/blocks';
import { World } from '../../src/world/World';

describe('World', () => {
  it('reads and edits negative world coordinates', () => {
    const world = new World('overworld', 11);
    world.ensureChunk(-1, 0);
    world.setBlock(-1, 40, 0, BlockId.Glass);
    expect(world.getBlock(-1, 40, 0)).toBe(BlockId.Glass);
    expect(world.getEdits(-1, 0)).toEqual([{ x: 15, y: 40, z: 0, block: BlockId.Glass }]);
  });

  it('marks both chunks dirty when an edge block changes', () => {
    const world = new World('overworld', 11);
    world.ensureChunk(0, 0); world.ensureChunk(1, 0);
    const listener = vi.fn(); world.onChunksDirty(listener);
    world.setBlock(15, 40, 2, BlockId.Planks);
    expect(listener).toHaveBeenCalledWith(expect.arrayContaining(['overworld:0:0', 'overworld:1:0']));
  });
});
```

Create `tests/unit/ChunkStore.test.ts` to assert state transitions:

```ts
import { describe, expect, it } from 'vitest';
import { ChunkStore } from '../../src/world/ChunkStore';

describe('ChunkStore', () => {
  it('moves a chunk through queued, generating, ready and unloaded', () => {
    const store = new ChunkStore();
    store.queue('overworld', 0, 0); store.markGenerating('overworld', 0, 0);
    expect(store.stateOf('overworld', 0, 0)).toBe('generating');
    store.putReady(store.generateNow('overworld', 7, 0, 0));
    expect(store.stateOf('overworld', 0, 0)).toBe('ready');
    store.unload('overworld', 0, 0);
    expect(store.stateOf('overworld', 0, 0)).toBe('missing');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- ChunkStore.test.ts World.test.ts`

Expected: FAIL because store and world modules do not exist.

- [ ] **Step 3: 实现状态存储和稀疏增量**

Create `src/world/ChunkStore.ts` with:

```ts
import type { BlockEdit, WorldId } from '../types';
import { BlockId } from './blocks';
import { Chunk } from './Chunk';
import { chunkKey } from './coordinates';
import { generateChunk } from './generators';

export type ChunkState = 'missing' | 'queued' | 'generating' | 'meshing' | 'ready';
interface Entry { state: ChunkState; chunk?: Chunk; edits: Map<number, BlockId> }

export class ChunkStore {
  private readonly entries = new Map<string, Entry>();
  private entry(worldId: WorldId, x: number, z: number): Entry {
    const key = chunkKey(worldId, x, z);
    let entry = this.entries.get(key);
    if (!entry) { entry = { state: 'missing', edits: new Map() }; this.entries.set(key, entry); }
    return entry;
  }
  stateOf(worldId: WorldId, x: number, z: number): ChunkState { return this.entry(worldId, x, z).state; }
  queue(worldId: WorldId, x: number, z: number): void { this.entry(worldId, x, z).state = 'queued'; }
  markGenerating(worldId: WorldId, x: number, z: number): void { this.entry(worldId, x, z).state = 'generating'; }
  markMeshing(worldId: WorldId, x: number, z: number): void { this.entry(worldId, x, z).state = 'meshing'; }
  generateNow(worldId: WorldId, seed: number, x: number, z: number): Chunk { return generateChunk(worldId, seed, x, z); }
  putReady(chunk: Chunk): void { const entry = this.entry(chunk.worldId, chunk.x, chunk.z); entry.chunk = chunk; entry.state = 'ready'; }
  get(worldId: WorldId, x: number, z: number): Chunk | undefined { return this.entry(worldId, x, z).chunk; }
  unload(worldId: WorldId, x: number, z: number): void { const entry = this.entry(worldId, x, z); entry.chunk = undefined; entry.state = 'missing'; }
  edits(worldId: WorldId, x: number, z: number): Map<number, BlockId> { return this.entry(worldId, x, z).edits; }
  replaceEdits(worldId: WorldId, x: number, z: number, edits: BlockEdit[]): void {
    const entry = this.entry(worldId, x, z); entry.edits.clear();
    for (const edit of edits) entry.edits.set(Chunk.index(edit.x, edit.y, edit.z), edit.block);
  }
}
```

- [ ] **Step 4: 实现 World 的稳定公开接口**

Create `src/world/World.ts` with public methods:

```ts
constructor(readonly worldId: WorldId, readonly seed: number, readonly store = new ChunkStore())
ensureChunk(chunkX: number, chunkZ: number): Chunk
installChunk(chunk: Chunk): void
getBlock(x: number, y: number, z: number): BlockId
setBlock(x: number, y: number, z: number, block: BlockId): boolean
getEdits(chunkX: number, chunkZ: number): BlockEdit[]
loadEdits(chunkX: number, chunkZ: number, edits: BlockEdit[]): void
onChunksDirty(listener: (keys: string[]) => void): () => void
```

Implementation rules:

```ts
// getBlock: y outside [0, CHUNK_HEIGHT) => Air; loaded chunk => local get;
// missing chunk => sampleGeneratedBlock so raycast/physics remain deterministic.
// setBlock: compare against current value; return false if unchanged.
// On change, ensure the owning chunk, write the byte, and store the local edit only
// when it differs from sampleGeneratedBlock; delete the edit if restored to baseline.
// Dirty keys always include the owner. Add x-neighbor at localX 0/15 and z-neighbor
// at localZ 0/15. Deduplicate with Set before notifying listeners.
```

Use `Chunk.index` as the edit-map key and sort `getEdits` by index before converting indexes back with:

```ts
const y = Math.floor(index / 256);
const rem = index - y * 256;
const z = Math.floor(rem / 16);
const x = rem - z * 16;
```

- [ ] **Step 5: 验证并提交**

Run: `npm test -- ChunkStore.test.ts World.test.ts && npm test`

Expected: all tests PASS.

```bash
git add src/world tests/unit
git commit -m "feat: manage chunk state and voxel edits"
```

---

### Task 5: 实现可见面/贪心网格与 Worker 协议

**Files:**
- Create: `voxel-game/src/world/meshing.ts`
- Create: `voxel-game/src/world/workerProtocol.ts`
- Create: `voxel-game/src/workers/world.worker.ts`
- Create: `voxel-game/tests/unit/meshing.test.ts`
- Create: `voxel-game/tests/unit/workerProtocol.test.ts`

- [ ] **Step 1: 写网格失败测试**

Create `tests/unit/meshing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BlockId } from '../../src/world/blocks';
import { Chunk } from '../../src/world/Chunk';
import { buildChunkMesh } from '../../src/world/meshing';

describe('buildChunkMesh', () => {
  it('greedily merges a solid chunk into six opaque quads', () => {
    const chunk = new Chunk('overworld', 0, 0);
    chunk.blocks.fill(BlockId.Stone);
    const mesh = buildChunkMesh(chunk, () => BlockId.Air);
    expect(mesh.opaque.indices.length / 6).toBe(6);
    expect(mesh.transparent.indices.length).toBe(0);
  });

  it('culls the shared face of two neighboring blocks', () => {
    const chunk = new Chunk('overworld', 0, 0);
    chunk.set(1, 1, 1, BlockId.Stone); chunk.set(2, 1, 1, BlockId.Stone);
    const mesh = buildChunkMesh(chunk, () => BlockId.Air);
    expect(mesh.opaque.indices.length / 6).toBe(6);
  });

  it('keeps water in a separate transparent mesh', () => {
    const chunk = new Chunk('overworld', 0, 0); chunk.set(1, 1, 1, BlockId.Water);
    const mesh = buildChunkMesh(chunk, () => BlockId.Air);
    expect(mesh.transparent.indices.length / 6).toBe(6);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- meshing.test.ts`

Expected: FAIL because `buildChunkMesh` does not exist.

- [ ] **Step 3: 固定网格 DTO 和贪心算法**

Create `src/world/meshing.ts` with these exports:

```ts
export interface MeshPart {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tileIds: Float32Array;
  shades: Float32Array;
  indices: Uint32Array;
}
export interface ChunkMeshData { opaque: MeshPart; transparent: MeshPart }
export type NeighborSampler = (worldX: number, y: number, worldZ: number) => BlockId;
export function buildChunkMesh(chunk: Chunk, sampleNeighbor: NeighborSampler): ChunkMeshData;
```

Implement the standard three-axis greedy rectangle pass for opaque faces:

1. For each principal axis `d = 0..2`, define `u = (d + 1) % 3`, `v = (d + 2) % 3`.
2. Sweep slice `-1` through `dims[d]-1`; compare block A on the negative side with B on the positive side.
3. A mask cell is empty if both blocks have equal opacity or neither visible side is opaque. Otherwise store `{ block, backFace, tileId }` for the visible opaque side.
4. Scan the 2D mask left-to-right, top-to-bottom. Measure maximal equal width, then maximal rows with the same mask values. Emit one quad and clear that rectangle.
5. Winding order depends on `backFace`; normals are exactly `±axis`; UV repeats over merged width/height; `tileIds` has one texture tile index per vertex.
6. The texture face name comes from `BLOCKS[id].textures.top` for positive Y, `.bottom` for negative Y, otherwise `.side`.
7. `shades` uses `1.0` for top, `.82` for horizontal sides and `.62` for bottom.

For transparent blocks, iterate all cells and six faces without greedy merging. Emit a face when the adjacent block differs and is not opaque; never emit internal faces between identical water blocks. Return typed arrays, including empty zero-length arrays.

Use a local mutable builder:

```ts
interface MutablePart { positions: number[]; normals: number[]; uvs: number[]; tileIds: number[]; shades: number[]; indices: number[] }
const finish = (part: MutablePart): MeshPart => ({
  positions: new Float32Array(part.positions), normals: new Float32Array(part.normals),
  uvs: new Float32Array(part.uvs), tileIds: new Float32Array(part.tileIds),
  shades: new Float32Array(part.shades), indices: new Uint32Array(part.indices),
});
```

The task is complete only when the solid-chunk assertion is exactly six quads; a per-block face emitter does not satisfy it.

- [ ] **Step 4: 定义 Worker 判别联合并实现 Worker**

Create `src/world/workerProtocol.ts`:

```ts
import type { BlockEdit, WorldId } from '../types';
import type { ChunkMeshData } from './meshing';

export interface GenerateChunkRequest {
  type: 'generate'; requestId: number; generation: number; worldId: WorldId;
  seed: number; chunkX: number; chunkZ: number; edits: BlockEdit[];
}
export interface CancelGenerationRequest { type: 'cancel-before'; generation: number }
export type WorldWorkerRequest = GenerateChunkRequest | CancelGenerationRequest;
export interface ChunkReadyResponse {
  type: 'chunk-ready'; requestId: number; generation: number; worldId: WorldId;
  chunkX: number; chunkZ: number; blocks: Uint8Array; mesh: ChunkMeshData;
}
export interface WorkerErrorResponse {
  type: 'worker-error'; requestId: number; generation: number; message: string;
}
export type WorldWorkerResponse = ChunkReadyResponse | WorkerErrorResponse;
```

Create `src/workers/world.worker.ts`. On `generate`, generate the chunk, apply edits with `chunk.set`, and call `buildChunkMesh`. Its neighbor sampler calls `sampleGeneratedBlock` for coordinates outside the chunk; inside it reads the edited chunk. Post typed-array buffers as transferables. Ignore requests whose `generation` is lower than the most recent `cancel-before` generation. Catch errors and return `worker-error` with `error instanceof Error ? error.message : String(error)`.

- [ ] **Step 5: 验证网格、类型检查和提交**

Run: `npm test -- meshing.test.ts && npm run build`

Expected: all mesh assertions PASS; Vite bundles the module worker.

```bash
git add src/world/meshing.ts src/world/workerProtocol.ts src/workers tests/unit/meshing.test.ts
git commit -m "feat: mesh voxel chunks in a web worker"
```

---

### Task 6: 实现原创像素纹理、Three.js 渲染和区块调度

**Files:**
- Create: `voxel-game/src/textures/TextureAtlas.ts`
- Create: `voxel-game/src/engine/ChunkScheduler.ts`
- Create: `voxel-game/src/engine/Renderer.ts`
- Create: `voxel-game/tests/unit/ChunkScheduler.test.ts`
- Modify: `voxel-game/src/app/GameApp.ts`
- Modify: `voxel-game/src/styles.css`

- [ ] **Step 1: 写调度器失败测试**

Create `tests/unit/ChunkScheduler.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ChunkScheduler } from '../../src/engine/ChunkScheduler';

describe('ChunkScheduler', () => {
  it('prioritizes nearby chunks and removes chunks beyond the unload radius', () => {
    const scheduler = new ChunkScheduler(2);
    const desired = scheduler.desiredChunks(0, 0, { x: 1, z: 0 });
    expect(desired[0]).toEqual({ x: 0, z: 0 });
    expect(desired.findIndex((c) => c.x === 1 && c.z === 0)).toBeLessThan(desired.findIndex((c) => c.x === -1 && c.z === 0));
    expect(scheduler.shouldUnload({ x: 4, z: 0 }, 0, 0)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- ChunkScheduler.test.ts`

Expected: FAIL because scheduler is missing.

- [ ] **Step 3: 实现确定性视距调度**

Create `src/engine/ChunkScheduler.ts`:

```ts
import type { ChunkCoord } from '../types';

export class ChunkScheduler {
  constructor(readonly viewDistance: number) {
    if (viewDistance < 2 || viewDistance > 8) throw new RangeError('viewDistance must be 2..8');
  }
  desiredChunks(centerX: number, centerZ: number, facing: { x: number; z: number }): ChunkCoord[] {
    const chunks: Array<ChunkCoord & { score: number }> = [];
    for (let z = -this.viewDistance; z <= this.viewDistance; z += 1) for (let x = -this.viewDistance; x <= this.viewDistance; x += 1) {
      const distance = Math.hypot(x, z);
      if (distance > this.viewDistance + .25) continue;
      const length = distance || 1;
      const ahead = (x / length) * facing.x + (z / length) * facing.z;
      chunks.push({ x: centerX + x, z: centerZ + z, score: distance - ahead * .2 });
    }
    return chunks.sort((a, b) => a.score - b.score || a.z - b.z || a.x - b.x).map(({ x, z }) => ({ x, z }));
  }
  shouldUnload(coord: ChunkCoord, centerX: number, centerZ: number): boolean {
    return Math.hypot(coord.x - centerX, coord.z - centerZ) > this.viewDistance + 1.5;
  }
}
```

- [ ] **Step 4: 生成 16×16 原创纹理图集**

Create `src/textures/TextureAtlas.ts` with `TILE_SIZE = 16`, all `TextureName` entries in a fixed array, and:

```ts
export interface TextureAtlasResult {
  texture: THREE.CanvasTexture;
  tileIndex: Readonly<Record<TextureName, number>>;
  columns: number;
  rows: number;
}
export function createTextureAtlas(): TextureAtlasResult;
```

For each tile, fill a base color and then place 42 deterministic one-pixel speckles using the tile index as a local xorshift seed. Draw explicit original patterns: grass top has three greens, grass side has a four-pixel green rim over brown, logs have concentric top rings and vertical side streaks, glass has a pale border and diagonal glint, water has alternating blue horizontal strokes, lava has orange/yellow veins, glow crystal has cyan diagonal facets. Set `texture.magFilter` and `minFilter` to `THREE.NearestFilter`, `colorSpace` to `THREE.SRGBColorSpace`, and `generateMipmaps = false`.

The atlas module must not fetch image URLs or contain base64 copies of external assets.

- [ ] **Step 5: 实现 Renderer 的完整边界**

Create `src/engine/Renderer.ts` with:

```ts
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.PerspectiveCamera;
  constructor(host: HTMLElement, atlas: TextureAtlasResult);
  setWorldStyle(worldId: WorldId): void;
  setCamera(position: Vec3, yaw: number, pitch: number): void;
  installChunk(worldId: WorldId, chunkX: number, chunkZ: number, mesh: ChunkMeshData): void;
  removeChunk(worldId: WorldId, chunkX: number, chunkZ: number): void;
  setTargetBlock(position: Vec3 | null): void;
  render(timeSeconds: number): void;
  resize(): void;
  dispose(): void;
}
```

Implementation requirements:

- Construct `WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })`, cap pixel ratio at `2`, and append the canvas with `data-testid="game-canvas"`.
- Build one `BufferGeometry` from each non-empty `MeshPart`; attach `position`, `normal`, `uv`, `tileId`, `shade` attributes and index.
- Use a small custom shader or `onBeforeCompile` so `tileId` maps local repeating UV into the atlas. Opaque uses depth write; transparent uses `transparent: true`, `opacity: .72`, `depthWrite: false`.
- Position each chunk group at `(chunkX * 16, 0, chunkZ * 16)` and key it by dimension and coordinates.
- Use hemisphere plus directional light, distance fog, and dimension palettes: blue/green overworld, dark red ember, pale cyan skylands.
- Render a `LineSegments` unit-cube outline offset by `.002` around the targeted block.
- Resize on `window.resize`; dispose geometries, materials, texture and WebGL renderer in `dispose`.

- [ ] **Step 6: 将标题页接到空渲染场景**

Change `GameApp.mount()` so clicking `[data-action="enter"]` replaces the title panel with `<div class="game-host"></div>`, constructs the atlas and renderer, and calls one animation frame. Catch constructor errors and render:

```html
<section class="fatal-error" role="alert">
  <h1>无法启动方境</h1>
  <p>此浏览器需要 WebGL2。请更新浏览器或启用硬件加速。</p>
  <button type="button" data-action="reload">重新载入</button>
</section>
```

Add canvas and `.fatal-error` full-screen styles. Keep `destroy()` idempotent.

- [ ] **Step 7: 验证并提交**

Run: `npm test -- ChunkScheduler.test.ts GameApp.test.ts && npm run build`

Expected: tests PASS and title-entry build succeeds.

```bash
git add src tests/unit
git commit -m "feat: render scheduled voxel chunks"
```

---

### Task 7: 实现固定步长、输入、AABB 物理和体素 DDA

**Files:**
- Create: `voxel-game/src/app/GameClock.ts`
- Create: `voxel-game/src/engine/InputManager.ts`
- Create: `voxel-game/src/player/PlayerPhysics.ts`
- Create: `voxel-game/src/player/VoxelRaycast.ts`
- Create: `voxel-game/src/player/PlayerController.ts`
- Create: `voxel-game/tests/unit/GameClock.test.ts`
- Create: `voxel-game/tests/unit/PlayerPhysics.test.ts`
- Create: `voxel-game/tests/unit/VoxelRaycast.test.ts`

- [ ] **Step 1: 写固定步、碰撞和射线失败测试**

Create `tests/unit/VoxelRaycast.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BlockId } from '../../src/world/blocks';
import { voxelRaycast } from '../../src/player/VoxelRaycast';

it('returns the hit voxel, entry face and previous empty voxel', () => {
  const hit = voxelRaycast({ x: .5, y: 1.5, z: .5 }, { x: 1, y: 0, z: 0 }, 6,
    (x, y, z) => x === 3 && y === 1 && z === 0 ? BlockId.Stone : BlockId.Air);
  expect(hit).toEqual({ block: { x: 3, y: 1, z: 0 }, normal: { x: -1, y: 0, z: 0 }, adjacent: { x: 2, y: 1, z: 0 }, distance: 2.5 });
});
```

Create `tests/unit/PlayerPhysics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BlockId } from '../../src/world/blocks';
import { createPlayerBody, stepPlayer } from '../../src/player/PlayerPhysics';

const floor = (_x: number, y: number) => y < 0 ? BlockId.Stone : BlockId.Air;

it('lands on a floor without penetrating it', () => {
  let body = createPlayerBody({ x: .5, y: 2, z: .5 });
  for (let i = 0; i < 120; i += 1) body = stepPlayer(body, { moveX: 0, moveZ: 0, jump: false, sprint: false, ascend: false, descend: false }, 1 / 60, floor);
  expect(body.position.y).toBeCloseTo(0, 4);
  expect(body.grounded).toBe(true);
});
```

Create `tests/unit/GameClock.test.ts` to assert a `0.05` second frame executes three `1/60` steps and never executes more than five catch-up steps.

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- GameClock.test.ts PlayerPhysics.test.ts VoxelRaycast.test.ts`

Expected: FAIL with unresolved modules.

- [ ] **Step 3: 实现固定步长与 DDA**

`GameClock` stores an accumulator, clamps frame delta to `0.1`, invokes `fixedUpdate(1 / 60)` at most five times, then calls `render(alpha, timeSeconds)`. It exposes `start()`, `stop()` and an injectable `advance(deltaSeconds)` used by the unit test.

Implement `voxelRaycast(origin, normalizedDirection, maxDistance, sample)` using Amanatides-Woo traversal. Return:

```ts
export interface VoxelHit {
  block: Vec3;
  normal: Vec3;
  adjacent: Vec3;
  distance: number;
}
```

Compute `step`, `tDelta`, and first `tMax` for each axis; advance the smallest `tMax`; the entry normal is the negative step on that axis. Stop after `maxDistance`, return `null` for no hit, and round returned distance to exact traversal `t` without epsilon except for the initial floor operation.

- [ ] **Step 4: 实现 AABB 玩家物理**

Use width `.6`, height `1.8`, eye height `1.62`, gravity `-24`, jump velocity `8.2`, walk speed `5`, sprint speed `8`, flight speed `11`. Export:

```ts
export interface MovementIntent { moveX: number; moveZ: number; jump: boolean; sprint: boolean; ascend: boolean; descend: boolean }
export interface PlayerBody { position: Vec3; velocity: Vec3; grounded: boolean; flying: boolean }
export function createPlayerBody(position: Vec3): PlayerBody;
export function playerAabb(position: Vec3): { min: Vec3; max: Vec3 };
export function stepPlayer(body: PlayerBody, intent: MovementIntent, dt: number, sample: BlockSampler, yaw?: number): PlayerBody;
```

Resolve each axis separately. For an axis displacement, scan integer cells overlapped by the candidate AABB; if a collidable block overlaps, clamp to the nearest voxel boundary minus/plus half width or player height and zero that velocity component. Set `grounded` only when downward Y movement is clamped. Subdivide displacement so no substep exceeds `.45` blocks.

- [ ] **Step 5: 实现输入和 PlayerController**

`InputManager` owns listeners for `keydown`, `keyup`, `mousemove`, `mousedown`, `mouseup`, `wheel`, `contextmenu`, `blur`, and `pointerlockchange`. It exposes `isDown(code)`, `consumePress(code)`, `consumeMouseButton(button)`, `consumeWheel()`, `consumeLookDelta()`, `requestPointerLock()`, `isPointerLocked()`, and `dispose()`. On blur/pointer unlock, clear held keys and deltas.

`PlayerController` owns `PlayerBody`, yaw, pitch, selected slot and target hit. It converts WASD to local intent, clamps pitch to `±(Math.PI / 2 - .01)`, toggles flight on consumed `KeyF`, calls `stepPlayer`, calculates eye origin, calls `voxelRaycast` at distance six, and exposes a read-only `snapshot()` plus `restore(snapshot)`.

- [ ] **Step 6: 验证并提交**

Run: `npm test -- GameClock.test.ts PlayerPhysics.test.ts VoxelRaycast.test.ts && npm test`

Expected: all tests PASS.

```bash
git add src/app src/engine/InputManager.ts src/player tests/unit
git commit -m "feat: add first-person voxel movement"
```

---

### Task 8: 实现版本化 IndexedDB 存档与临时会话降级

**Files:**
- Create: `voxel-game/src/persistence/saveTypes.ts`
- Create: `voxel-game/src/persistence/SaveRepository.ts`
- Create: `voxel-game/tests/unit/SaveRepository.test.ts`
- Modify: `voxel-game/package.json`

- [ ] **Step 1: 安装内存 IndexedDB 并写失败测试**

Run: `npm install -D fake-indexeddb`

Create `tests/unit/SaveRepository.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { BlockId } from '../../src/world/blocks';
import { SaveRepository } from '../../src/persistence/SaveRepository';

const names: string[] = [];
afterEach(async () => { for (const name of names.splice(0)) indexedDB.deleteDatabase(name); });

it('round-trips metadata, player and sparse chunk edits', async () => {
  const name = `voxel-test-${crypto.randomUUID()}`; names.push(name);
  const saves = await SaveRepository.open(name);
  await saves.saveWorldMeta({ id: 'main', schemaVersion: 1, seed: 77, createdAt: 1, updatedAt: 2 });
  await saves.saveChunkEdits('overworld', -1, 2, [{ x: 15, y: 40, z: 0, block: BlockId.Glass }]);
  expect((await saves.loadWorldMeta())?.seed).toBe(77);
  expect(await saves.loadChunkEdits('overworld', -1, 2)).toEqual([{ x: 15, y: 40, z: 0, block: BlockId.Glass }]);
  saves.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- SaveRepository.test.ts`

Expected: FAIL because repository modules are missing.

- [ ] **Step 3: 定义 schema 并实现仓库**

Create `src/persistence/saveTypes.ts`:

```ts
import type { DBSchema } from 'idb';
import type { BlockEdit, GameSettings, PlayerSnapshot, WorldId } from '../types';

export interface WorldMeta { id: 'main'; schemaVersion: 1; seed: number; createdAt: number; updatedAt: number }
export interface ChunkEditRecord { key: string; worldId: WorldId; chunkX: number; chunkZ: number; edits: BlockEdit[] }
export interface PlayerRecord { worldId: WorldId; snapshot: PlayerSnapshot }
export interface VoxelSaveDb extends DBSchema {
  worldMeta: { key: string; value: WorldMeta };
  playerState: { key: WorldId; value: PlayerRecord };
  chunkEdits: { key: string; value: ChunkEditRecord };
  settings: { key: string; value: GameSettings };
}
```

Create `src/persistence/SaveRepository.ts` using `openDB<VoxelSaveDb>(name, 1, { upgrade })`. In upgrade, create the four stores if absent. Provide:

```ts
static async open(name = 'fangjing-save'): Promise<SaveRepository>
static memoryOnly(reason: string): SaveRepository
readonly persistent: boolean
readonly failureReason: string | null
loadWorldMeta(): Promise<WorldMeta | null>
saveWorldMeta(meta: WorldMeta): Promise<void>
loadPlayer(worldId: WorldId): Promise<PlayerSnapshot | null>
savePlayer(snapshot: PlayerSnapshot): Promise<void>
loadChunkEdits(worldId: WorldId, chunkX: number, chunkZ: number): Promise<BlockEdit[]>
saveChunkEdits(worldId: WorldId, chunkX: number, chunkZ: number, edits: BlockEdit[]): Promise<void>
loadSettings(defaults: GameSettings): Promise<GameSettings>
saveSettings(settings: GameSettings): Promise<void>
resetWorld(): Promise<void>
flush(): Promise<void>
close(): void
```

Memory mode uses Maps with the same semantics. Persistent methods catch transaction errors, switch to memory mode, retain the attempted value, and set `failureReason`. `saveChunkEdits` deletes a record when `edits.length === 0`. `flush()` awaits all pending writes stored in a `Set<Promise<void>>`.

- [ ] **Step 4: 增加防抖编辑队列测试和实现**

Add a fake-timer test that calls `queueChunkEdits` twice for the same key, advances 300 ms, then asserts only the latest edit set was saved. Implement:

```ts
queueChunkEdits(worldId: WorldId, chunkX: number, chunkZ: number, edits: BlockEdit[]): void
```

Use one timer per chunk key, clone the edit array at queue time, debounce by `250 ms`, and ensure `flush()` immediately executes all queued writes before awaiting them.

- [ ] **Step 5: 验证并提交**

Run: `npm test -- SaveRepository.test.ts && npm run build`

Expected: persistent and debounced tests PASS.

```bash
git add package.json package-lock.json src/persistence tests/unit/SaveRepository.test.ts
git commit -m "feat: persist voxel worlds in indexeddb"
```

---

### Task 9: 实现 HUD、快捷栏、方块选择和暂停菜单

**Files:**
- Create: `voxel-game/src/ui/Hud.ts`
- Create: `voxel-game/src/ui/Hotbar.ts`
- Create: `voxel-game/src/ui/BlockPicker.ts`
- Create: `voxel-game/src/ui/PauseMenu.ts`
- Create: `voxel-game/tests/unit/ui.test.ts`
- Modify: `voxel-game/src/styles.css`

- [ ] **Step 1: 写 UI 失败测试**

Create `tests/unit/ui.test.ts`:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { BlockId } from '../../src/world/blocks';
import { Hotbar } from '../../src/ui/Hotbar';
import { PauseMenu } from '../../src/ui/PauseMenu';

afterEach(() => { document.body.innerHTML = ''; });

it('renders nine slots and reports selection changes', () => {
  const changed = vi.fn();
  const hotbar = new Hotbar(document.body, [BlockId.Grass, BlockId.Stone, BlockId.Planks, BlockId.Glass, BlockId.Water, BlockId.EmberRock, BlockId.Lava, BlockId.CloudStone, BlockId.GlowCrystal], changed);
  hotbar.select(3);
  expect(document.querySelectorAll('[data-hotbar-slot]')).toHaveLength(9);
  expect(changed).toHaveBeenCalledWith(3, BlockId.Glass);
  hotbar.destroy();
});

it('requires a second click before reset', () => {
  const reset = vi.fn();
  const menu = new PauseMenu(document.body, { onResume: vi.fn(), onWorldChange: vi.fn(), onSettings: vi.fn(), onReset: reset, onTitle: vi.fn() });
  menu.show();
  document.querySelector<HTMLButtonElement>('[data-action="reset"]')!.click();
  expect(reset).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('[data-action="confirm-reset"]')!.click();
  expect(reset).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- ui.test.ts`

Expected: FAIL because UI classes do not exist.

- [ ] **Step 3: 实现四个独立 DOM 组件**

`Hud` creates a root with crosshair, selected name, world name, save warning, toast region and optional F3 panel. Methods:

```ts
setSelectedBlock(id: BlockId): void
setWorld(worldId: WorldId): void
setDebug(data: { fps: number; position: Vec3; chunks: number; pending: number }): void
setDebugVisible(visible: boolean): void
setSaveWarning(reason: string | null): void
notify(message: string, kind?: 'info' | 'error'): void
destroy(): void
```

`Hotbar` renders exactly nine buttons with `data-hotbar-slot`, `aria-label` from `BLOCKS[id].name`, and selected class/`aria-pressed`. Clamp/wrap `select(index)` and expose `selectedBlock`.

`BlockPicker` renders every non-Air block grouped as natural/building/special. It uses `role="dialog"`, closes on `E` or Escape, and calls `(block: BlockId) => void` on choice.

`PauseMenu` uses the callback object shown in the test. It renders Resume, three dimension buttons, settings controls (range: sensitivity `.05..1`, view distance `2..8`, volume `0..1`; checkbox: debug; select: quality), reset and title actions. First reset click swaps in a confirmation row; cancel restores the original controls.

- [ ] **Step 4: 完成像素 HUD 样式**

Append CSS for `.hud`, `.crosshair`, `.hotbar`, `.hotbar-slot`, `.selected`, `.pause-backdrop`, `.dialog`, `.block-grid`, `.debug-panel`, `.toast-region`, and `.save-warning`. Use translucent dark panels, 2–3 px hard borders, no blur-heavy effects, `image-rendering: pixelated`, minimum 44 px interactive targets, and media query below 720 px to scale the hotbar to fit without enabling touch gameplay.

- [ ] **Step 5: 验证并提交**

Run: `npm test -- ui.test.ts && npm run build`

Expected: both UI tests PASS and CSS builds.

```bash
git add src/ui src/styles.css tests/unit/ui.test.ts
git commit -m "feat: add creative-mode game interface"
```

---

### Task 10: 装配流式世界、玩家交互、维度切换与状态机

**Files:**
- Modify: `voxel-game/src/app/GameApp.ts`
- Modify: `voxel-game/src/world/World.ts`
- Create: `voxel-game/tests/unit/GameApp.integration.test.ts`

- [ ] **Step 1: 写可注入依赖的状态机失败测试**

Create `tests/unit/GameApp.integration.test.ts` with fake renderer, worker, save repository and clock. Assert this state sequence:

```ts
expect(app.state).toBe('ready');
await app.enterWorld();
expect(app.state).toBe('loading-world');
fakeWorker.respondToAll();
await app.whenSpawnReady();
expect(app.state).toBe('playing');
await app.switchWorld('ember');
expect(app.currentWorldId).toBe('ember');
expect(fakeSaves.savedWorldIds).toContain('overworld');
app.pause();
expect(app.state).toBe('paused');
```

Define injectable `GameDependencies` in `GameApp.ts` for `createRenderer`, `createWorker`, `openSaves`, and `createClock`; production defaults construct real implementations.

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- GameApp.integration.test.ts`

Expected: FAIL because the lifecycle API is not implemented.

- [ ] **Step 3: 实现顶层状态机和启动流程**

Use:

```ts
export type GameState = 'booting' | 'ready' | 'loading-world' | 'playing' | 'paused' | 'error';
```

`mount()` transitions `booting → ready` after opening saves and loading settings/meta. If no meta exists, generate a cryptographically random unsigned 31-bit seed and save it. `enterWorld()` creates renderer/input/UI/worker, restores the current dimension player or calls `findSafeSpawn`, enqueues all chunks within radius two, and remains `loading-world` until the center plus its eight neighbors are installed.

Keep counters and maps:

```ts
private generation = 1;
private nextRequestId = 1;
private readonly inFlight = new Map<number, { worldId: WorldId; x: number; z: number }>();
private readonly installed = new Set<string>();
private readonly uploadQueue: ChunkReadyResponse[] = [];
```

Each render frame uploads at most two response meshes. Ignore responses whose generation/world no longer matches. Maintain at most two Worker generation requests in flight. Unload renderer chunks beyond scheduler radius and call `World.store.unload`.

- [ ] **Step 4: 连接玩家建造循环**

On each fixed step:

1. Update controller from `InputManager`.
2. Set renderer camera and target outline from controller snapshot/hit.
3. On left click with a hit, set target to Air, queue the owning chunk edits in `SaveRepository`, enqueue dirty owner/neighbors for remesh, and play break sound.
4. On right click, verify adjacent y range and `playerAabb` does not intersect the candidate unit cube; then place `hotbar.selectedBlock`, persist and remesh.
5. Number keys and wheel update hotbar/controller; `E` toggles picker; `Escape` pauses; `F3` toggles debug.
6. If player y < `-12`, restore that dimension’s safe spawn and zero velocity.
7. Every second update FPS, position, ready-chunk and pending-job counters.

Prevent context menu on the canvas. Only process destructive/place clicks while pointer lock is active and no dialog is open.

- [ ] **Step 5: 实现可靠维度切换与生命周期**

`switchWorld(target)` must:

- Save and flush the current `PlayerSnapshot`.
- Increment `generation`, send `cancel-before`, clear in-flight/upload/installed maps and dispose rendered chunks.
- Create/select the target `World`, load target player or safe spawn, load center-neighborhood edits, then request chunks.
- Apply dimension fog/light style before hiding the loading overlay.
- Return to `playing` only after 3×3 spawn chunks are installed.

On `visibilitychange` hidden, `beforeunload`, pause and return-to-title, call `savePlayer`, save settings and `flush`. `destroy()` removes every listener, terminates Worker, stops clock, disposes input/UI/renderer and closes saves exactly once.

- [ ] **Step 6: Worker 失败降级**

If Worker construction or a request fails, set a non-blocking warning and use a main-thread queue. Process one chunk using `generateChunk` + `buildChunkMesh` inside a `setTimeout(..., 0)` job, force view distance to two, and preserve the same `ChunkReadyResponse` path. A WebGL renderer construction failure remains fatal and uses the Task 6 compatibility screen.

- [ ] **Step 7: 验证并提交**

Run: `npm test -- GameApp.integration.test.ts && npm test && npm run build`

Expected: lifecycle integration and all unit tests PASS; production build succeeds.

```bash
git add src tests/unit/GameApp.integration.test.ts
git commit -m "feat: connect streaming worlds and creative building"
```

---

### Task 11: 加入程序音效、昼夜视觉、设置和性能边界

**Files:**
- Create: `voxel-game/src/audio/SoundSynth.ts`
- Modify: `voxel-game/src/engine/Renderer.ts`
- Modify: `voxel-game/src/app/GameApp.ts`
- Create: `voxel-game/tests/unit/SoundSynth.test.ts`
- Create: `voxel-game/tests/unit/settings.test.ts`

- [ ] **Step 1: 写设置归一化失败测试**

Add and test a `normalizeSettings(input)` export in `src/types.ts`:

```ts
expect(normalizeSettings({ mouseSensitivity: 9, viewDistance: 99, masterVolume: -2, quality: 'x', showDebug: 1 })).toEqual({
  mouseSensitivity: 1, viewDistance: 8, masterVolume: 0, quality: 'high', showDebug: true,
});
expect(normalizeSettings({})).toEqual({
  mouseSensitivity: .24, viewDistance: 4, masterVolume: .65, quality: 'high', showDebug: false,
});
```

- [ ] **Step 2: 实现设置边界并验证测试转绿**

`normalizeSettings` accepts `unknown`, narrows an object, clamps finite numbers, rounds view distance, defaults invalid quality to high, and coerces debug with `Boolean`. Run `npm test -- settings.test.ts` and expect PASS.

- [ ] **Step 3: 实现原创程序音效**

Create `SoundSynth` with lazy `AudioContext` creation after user gesture. `playBreak(block)`, `playPlace(block)`, `playStep(block)` create oscillator/noise bursts shorter than 140 ms, route through a gain node, and vary pitch using block properties plus a local counter. `setVolume(0..1)`, `resume()`, and `dispose()` are idempotent. It must not load audio URLs.

Use a dependency-injected `AudioContext` factory in tests. Assert no context is created in the constructor, `resume()` creates one, and volume zero produces gain zero.

- [ ] **Step 4: 实现视觉循环和画质设置**

In `Renderer.render(timeSeconds)`, overworld day phase is `(timeSeconds / 180) % 1`; calculate sun elevation with `sin(phase * 2π)`, clamp ambient brightness to `.35..1`, interpolate sky/fog between night and day palettes, and rotate directional light. Ember uses constant red ambient; skylands uses a slower bright cyan cycle. Low quality caps pixel ratio at `1`, disables shade attribute use and transparent sorting extras; high quality restores cap `2`.

Settings changes apply immediately to input sensitivity, scheduler view distance, renderer quality, debug visibility and sound gain, then queue a settings save.

- [ ] **Step 5: 加入每帧预算和加载进度**

Keep hard budgets in `GameApp`: two Worker jobs in flight, two mesh uploads per frame, four dirty-remesh requests coalesced by chunk key, and no more than one debug DOM update per second. The loading overlay displays `已准备 X / 9 个出生区块`; update X only from actual installed spawn-neighborhood keys.

- [ ] **Step 6: 验证并提交**

Run: `npm test && npm run build`

Expected: all tests PASS; no TypeScript errors.

```bash
git add src tests/unit
git commit -m "feat: polish voxel audio visuals and settings"
```

---

### Task 12: Playwright 主流程、兼容性验证与交付文档

**Files:**
- Create: `voxel-game/tests/e2e/game.spec.ts`
- Modify: `voxel-game/src/app/GameApp.ts`
- Create: `voxel-game/README.md`
- Modify: `voxel-game/package.json`

- [ ] **Step 1: 安装 Chromium 并暴露仅开发模式测试驱动**

Run: `npx playwright install chromium`

In `GameApp`, when `import.meta.env.DEV`, expose `window.__FANGJING_TEST__` with:

```ts
interface FangjingTestDriver {
  state(): GameState;
  player(): PlayerSnapshot;
  setBlock(x: number, y: number, z: number, block: BlockId): void;
  getBlock(x: number, y: number, z: number): BlockId;
  switchWorld(worldId: WorldId): Promise<void>;
  flushSaves(): Promise<void>;
}
```

Delete the property in `destroy()`. Do not include shortcuts that bypass persistence or world rules.

- [ ] **Step 2: 写 Playwright 失败测试**

Create `tests/e2e/game.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('enters a world, edits a block, persists it and changes dimension', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '方境' })).toBeVisible();
  await page.getByRole('button', { name: '进入世界' }).click();
  await expect(page.locator('[data-testid="game-canvas"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__FANGJING_TEST__?.state())).toBe('playing');
  const player = await page.evaluate(() => window.__FANGJING_TEST__!.player());
  const x = Math.floor(player.position.x) + 2;
  const y = Math.floor(player.position.y);
  const z = Math.floor(player.position.z);
  await page.evaluate(({ x, y, z }) => {
    window.__FANGJING_TEST__!.setBlock(x, y, z, 9);
    return window.__FANGJING_TEST__!.flushSaves();
  }, { x, y, z });
  await page.reload();
  await page.getByRole('button', { name: '进入世界' }).click();
  await expect.poll(() => page.evaluate(() => window.__FANGJING_TEST__?.state())).toBe('playing');
  expect(await page.evaluate(({ x, y, z }) => window.__FANGJING_TEST__!.getBlock(x, y, z), { x, y, z })).toBe(9);
  await page.evaluate(() => window.__FANGJING_TEST__!.switchWorld('ember'));
  await expect.poll(() => page.evaluate(() => window.__FANGJING_TEST__?.player().worldId)).toBe('ember');
});

test('shows a useful message when WebGL2 is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (type === 'webgl2' || type === 'webgl') return null;
      return original.call(this, type, options);
    } as typeof original;
  });
  await page.goto('/');
  await page.getByRole('button', { name: '进入世界' }).click();
  await expect(page.getByRole('alert')).toContainText('WebGL2');
});
```

Add the TypeScript global declaration in `src/types.ts` so the driver compiles.

- [ ] **Step 3: 运行 E2E 并修正真实集成缺陷**

Run: `npm run test:e2e`

Expected: both tests PASS with no uncaught page errors. If a test reveals a defect, add the smallest corresponding Vitest regression test before changing source, then rerun that unit test and this E2E file.

- [ ] **Step 4: 编写完整 README**

Create `README.md` with:

- 项目简介和三维度截图占位不写入文档；只描述实际已有画面。
- Requirements: Node.js 20+ and desktop Chrome/Edge/Firefox with WebGL2.
- Exact install/run/test/build commands.
- Complete control table from the design.
- Features and explicit current limits: no survival, creatures, crafting, multiplayer, mobile controls or flowing liquids.
- Save location is browser IndexedDB; explain reset confirmation.
- Performance controls and 2–8 chunk view range.
- Original asset statement: all textures and sounds are generated by this project; no Minecraft assets/source are included; Minecraft is a trademark of Microsoft/Mojang and is not affiliated with this project.

- [ ] **Step 5: 执行完整验证**

Run in order:

```bash
npm test
npm run build
npm run test:e2e
npm run preview
```

With preview running, manually verify in Chromium:

1. Enter overworld and obtain pointer lock.
2. Walk, sprint, jump, toggle flight and cross at least three chunk boundaries.
3. Break/place at a chunk edge and confirm no visible crack.
4. Open block picker, select glass, use number keys and wheel.
5. Visit ember and skylands; confirm safe spawn and distinct fog/terrain.
6. Reload and confirm player position, selected slot and placed glass persist.
7. Change view distance 2→8→4 and confirm old meshes unload.
8. Leave the tab and return; confirm no stuck movement key.
9. Play for ten minutes while observing FPS and browser memory; target ≥45 FPS at 1080p/view distance 4 and no monotonically unbounded mesh count.

Stop preview after manual verification. Record any unmet target truthfully in README under Known Limitations rather than hiding it.

- [ ] **Step 6: 最终提交**

```bash
git add .
git commit -m "test: verify playable voxel sandbox"
git status --short
```

Expected: final status is empty, all automated checks are green, and manual verification results are documented.

---

## 规格覆盖检查

- 独立浏览器子项目和不破坏现有应用：Task 1。
- 原创像素视觉、天空、雾、光照和程序音效：Tasks 6、11。
- 三个确定性维度与安全出生：Task 3。
- 区块状态、流式加载、边界编辑、Worker 和贪心网格：Tasks 4–6、10。
- 第一人称移动、冲刺、跳跃、飞行、碰撞、六格射线：Task 7。
- 破坏、放置、防止放进玩家身体、快捷栏、方块选择：Tasks 9–10。
- IndexedDB 增量存档、恢复、迁移入口和不可用降级：Task 8、10。
- 标题、加载、暂停、错误、维度与设置状态：Tasks 1、9–11。
- 性能预算、45 FPS 人工底线和真实浏览器验证：Tasks 10–12。
- 单元、集成、E2E、构建和 README：所有任务，集中在 Task 12 收口。

## 执行纪律

- 每个功能先运行该任务中的失败测试，再写实现。
- 每个任务结束时运行指定测试；不得根据“看起来正确”跳过验证。
- 若实现暴露设计遗漏，先在当前计划或设计文档中记录明确决策，再修改代码。
- 不复制、抓取或下载《我的世界》的贴图、音效、模型、名称资源或源代码。
- 不修改 `voxel-game/` 之外的现有应用源码；设计和计划文档是唯一允许位于该目录之外的新增文件。