// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.aicode*/**', '.smoke/**', '.mimosa/**', 'docs/acceptance/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // The codebase deliberately uses `any` at provider/JSON boundary layers;
      // keep it a warning so new code trends toward typed without blocking.
      '@typescript-eslint/no-explicit-any': 'off',
      // Adoption-first: the existing tree predates linting. Real bugs stay as
      // errors (default from recommended); the noisy style backlog is downgraded
      // to warnings so `npm run lint` gates NEW error classes instead of
      // failing on 200 legacy findings. Tighten over time.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      'no-useless-escape': 'warn',
      'no-regex-spaces': 'warn',
      'no-control-regex': 'warn',
      'prefer-const': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
