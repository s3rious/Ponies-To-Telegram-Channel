import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
  { ignores: ['node_modules/**', 'logs/**', 'tmp/**', 'legacy/**'] },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked],
    plugins: { 'import-x': importX },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 2.1 — imports at top, exports at bottom, no inline exports
      'import-x/first': 'error',
      'import-x/exports-last': 'error',
      'import-x/group-exports': 'error',

      // 2.2 — no `else`; prefer early return
      'no-else-return': ['error', { allowElseIf: false }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'IfStatement[alternate]',
          message: 'No else allowed — use early return instead.',
        },
      ],

      // 2.3 — no `any`, no type casts (use `unknown` + typeguards)
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],

      // Args/vars starting with _ are intentionally unused
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Numbers and booleans interpolate safely; the strict default rejects them
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // node:test registers tests synchronously; the returned promise is safe to ignore
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', name: 'test', package: 'node:test' },
            { from: 'package', name: 'before', package: 'node:test' },
            { from: 'package', name: 'after', package: 'node:test' },
            { from: 'package', name: 'beforeEach', package: 'node:test' },
            { from: 'package', name: 'afterEach', package: 'node:test' },
            { from: 'package', name: 'describe', package: 'node:test' },
            { from: 'package', name: 'it', package: 'node:test' },
          ],
        },
      ],
    },
  },
);
