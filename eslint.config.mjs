import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.local/**', 'main.js', 'node_modules/**', 'dist/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
);
