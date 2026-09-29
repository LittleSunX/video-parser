import js from '@eslint/js'
import ts from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

export default ts.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**', 'coverage/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['frontend/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['worker/**/*.ts'],
    languageOptions: { globals: globals.worker },
  },
  {
    files: ['tests/**/*.js', '*.mjs', '*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['frontend/src/utils/download.ts', 'worker/src/index.ts'],
    // 文件名清理必须匹配不可打印控制字符。
    rules: { 'no-control-regex': 'off' },
  },
)
