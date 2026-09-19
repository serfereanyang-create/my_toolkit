/**
 * glob.d.ts — glob 包的最小类型声明
 * 
 * glob 从工作区父级 node_modules 解析且没有自带类型，
 * 这里只声明本项目用到的 globSync 签名。
 */
declare module 'glob' {
  export interface GlobSyncOptions {
    cwd?: string;
    ignore?: string[];
    absolute?: boolean;
    dot?: boolean;
    nodir?: boolean;
  }
  
  export function globSync(pattern: string, options?: GlobSyncOptions): string[];
  export function glob(pattern: string, options?: GlobSyncOptions): Promise<string[]>;
}
