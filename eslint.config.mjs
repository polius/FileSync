import globals from 'globals';

export default [
  {
    ignores: ['**/node_modules/**', 'web/js/vendors/**', 'e2e/**'],
  },
  {
    files: ['web/js/**/*.js', 'web/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        // Globals from scripts loaded before the modules (index.html).
        QRious: 'readonly',
        bootstrap: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-fallthrough': 'error',
      'no-async-promise-executor': 'error',
    },
  },
];
