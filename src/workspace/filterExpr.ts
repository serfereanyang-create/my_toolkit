/**
 * filterExpression.ts - Parse workspace filter expressions.
 *
 * 支持 pnpm 风格 --filter 的常见语法：
 *   "@scope/pkg"      精确包名
 *   "...pkg"          pkg 及其 chain 依赖者 (dependents)
 *   "pkg..."          pkg 及其 chain 被依赖 (dependencies)
 *   "./dir"           按目录匹配
 *   "name{dir}"       限定到 dir 下的包
 *   "!..."            排除
 * 复合用空格或逗号分隔；按出现顺序合并。
 */

export type FilterSelector =
  | { kind: 'name'; name: string }
  | { kind: 'path'; prefix: string }
  | { kind: 'since'; ref: string }
  | { kind: 'regex'; pattern: string };

export interface FilterExpr {
  /** 正向 selectors */
  includes: Array<{ selector: FilterSelector; expand: 'none' | 'deps' | 'dependents' | 'both' }>;
  excludes: Array<{ selector: FilterSelector; expand: 'none' | 'deps' | 'dependents' | 'both' }>;
}

export function parseFilter(input: string): FilterExpr {
  const includes: FilterExpr['includes'] = [];
  const excludes: FilterExpr['excludes'] = [];

  // 支持空格或逗号分隔多条
  const tokens = input
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const token of tokens) {
    let text = token;
    let negated = false;
    if (text.startsWith('!')) {
      negated = true;
      text = text.slice(1);
    }

    // Expand suffix / prefix
    let expand: 'none' | 'deps' | 'dependents' | 'both' = 'none';
    if (text.startsWith('...')) {
      text = text.slice(3);
      expand = expand === 'none' ? 'dependents' : 'both';
    }
    if (text.endsWith('...')) {
      text = text.slice(0, -3);
      expand = expand === 'dependents' ? 'both' : expand === 'both' ? 'both' : 'deps';
    }

    // path{...} form: "pkg{./dir}"
    let selector: FilterSelector;
    const braceOpen = text.indexOf('{');
    const braceClose = text.lastIndexOf('}');
    if (braceOpen > 0 && braceClose > braceOpen) {
      const name = text.slice(0, braceOpen);
      const dir = text.slice(braceOpen + 1, braceClose);
      selector = { kind: 'name', name: `${name}@${dir}` };
    } else if (text.startsWith('./') || text.startsWith('/')) {
      selector = { kind: 'path', prefix: text.replace(/^\.\//, '') };
    } else if (text.startsWith('~')) {
      // ~regex
      selector = { kind: 'regex', pattern: text.slice(1) };
    } else {
      selector = { kind: 'name', name: text };
    }

    if (negated) excludes.push({ selector, expand });
    else includes.push({ selector, expand });
  }

  return { includes, excludes };
}

/** 匹配 selector 是否命中指定包 */
export function selectorMatches(
  selector: FilterSelector,
  pkg: { name: string; dir: string },
): boolean {
  switch (selector.kind) {
    case 'name':
      return pkg.name === selector.name;
    case 'path':
      return pkg.dir === selector.prefix || pkg.dir.startsWith(selector.prefix + '/');
    case 'regex': {
      try {
        const re = new RegExp(selector.pattern);
        return re.test(pkg.name) || re.test(pkg.dir);
      } catch {
        return false;
      }
    }
    case 'since':
      // 未直接比较；由上层结合 git diff 决定
      return true;
  }
}
