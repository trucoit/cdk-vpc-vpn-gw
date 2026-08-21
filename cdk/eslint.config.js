// ESLint 9 flat config for the CDK app. typescript-eslint recommended rules
// over the TS sources and tests, plus the JS tooling scripts. Prettier owns
// formatting, so eslint-config-prettier (last) turns off style rules here.
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');

module.exports = tseslint.config(
  {
    ignores: ['cdk.out/**', 'dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['bin/**/*.ts', 'lib/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  {
    // The tooling scripts are plain CommonJS Node, not part of the TS project.
    files: ['tools/**/*.js', 'eslint.config.js', 'jest.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', process: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
